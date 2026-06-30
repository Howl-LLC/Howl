// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef, useCallback } from 'react';
import { socketService } from '../services/socket';
import * as voiceE2ee from '../services/voiceE2ee';
import { selectSframeDialect, isSupportedKeyFormat } from '../services/peerDialects';
import { KNOWN_CAPABILITIES } from '../shared/protocol';
import { logger } from '../services/logger';
import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import { fromBase64 } from '../services/cryptoHelpers';

/**
 * Voice E2EE key exchange hook.
 *
 * Orchestrates SFrame key distribution. On join, assumes leader optimistically
 * until voice-participants arrives; then runs selectSignedLeader locally and
 * gates all inbound voice-e2ee-key / voice-e2ee-rotate events against the
 * independently-elected leader — a lying server cannot inject an attacker-
 * controlled key even if it claims the attacker is oldest.
 */
export function useVoiceE2ee(
  channelId: string | null,
  currentUserId: string | null,
  setE2eeKey: ((key: Uint8Array) => Promise<void>) | null,
): void {
  const isLeaderRef = useRef(false);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  /** Monotonic session nonce — incremented each time the effect mounts (join). */
  const sessionNonceRef = useRef(0);

  const verifiedLeaderRef = useRef<string | null>(null);
  /** True once a voice-participants roster with >1 member has arrived.
   *  Gates the optimistic self-key: a late joiner who can already see peers
   *  must NOT publish frames under a self-generated key no existing peer holds. */
  const rosterSeenMultipleRef = useRef(false);
  /** Last verified signed roster, kept so the client can re-run leader
   *  election if the verified leader departs and no server rotate arrives. */
  const lastSignedRef = useRef<voiceE2ee.SignedVoiceParticipant[]>([]);
  /** Pending liveness-backstop timer (leader-departed, awaiting rotate). */
  const leaderLivenessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic election counter — drops a stale async election result when a
   *  newer roster supersedes an in-flight pin lookup. */
  const electionSeqRef = useRef(0);

  const stableSetE2eeKey = useCallback(
    (key: Uint8Array) => setE2eeKey?.(key),
    [setE2eeKey],
  );

  useEffect(() => {
    // Join is gated on ensureE2eUnlockedForCall(), so by the time we get a
    // channelId the vault is already unlocked. Don't re-check here — doing
    // so silently skipped the key-exchange for participants whose unlock
    // state went out of sync with the join flow.
    if (!channelId || !currentUserId) return;

    // Increment session nonce — guards against stale events from a prior
    // join session on the same channel (rapid leave+rejoin).
    const myNonce = ++sessionNonceRef.current;
    // Reset per-session election/roster state (rapid leave+rejoin reuse).
    rosterSeenMultipleRef.current = false;
    lastSignedRef.current = [];

    // `useVoiceChannel` eagerly seeds the voice session key during render so
    // the engine starts with a valid SFrame key (avoids a race that left the
    // room silent). Reuse that key here if present for the same channel;
    // otherwise generate a fresh one for this session.
    let initialKey = voiceE2ee.getVoiceKey();
    if (!initialKey || voiceE2ee.getVoiceChannelId() !== channelId) {
      initialKey = voiceE2ee.generateVoiceSessionKey();
      voiceE2ee.setVoiceKey(channelId, initialKey);
    }
    isLeaderRef.current = true;

    const optimisticTimer = setTimeout(() => {
      if (sessionNonceRef.current !== myNonce) return;
      // Only apply the optimistic self-generated key if we still
      // believe we're the leader AND no roster with other participants has
      // arrived. A late joiner into an established channel that already saw
      // peers must wait for the real leader's key (delivered via
      // request-key/voice-e2ee-key) instead of publishing under a key no
      // existing peer holds (which silences its outbound for the room).
      if (isLeaderRef.current && !rosterSeenMultipleRef.current) {
        stableSetE2eeKey(initialKey);
      }
    }, 500);

    // Resolve a peer's signing key via the client's TOFU pin store (the shared
    // MLS AIK store), not the server-supplied key: first sight pins, a later
    // mismatch returns null (peer dropped from election). Fails closed on error.
    const resolveTrustedSigningKey = async (
      userId: string,
      claimedSigPubB64: string,
    ): Promise<string | null> => {
      try {
        const ok = await mlsGroupStore.pinOrVerifyAik(userId, fromBase64(claimedSigPubB64));
        return ok ? claimedSigPubB64 : null;
      } catch {
        return null;
      }
    };

    // Additive listener — the primary onVoiceParticipants is single-slot and
    // already claimed by App.tsx and useCallSession.
    const unsubscribeParticipants = socketService.addVoiceParticipantsListener(async (chId, participants) => {
      if (chId !== channelIdRef.current) return;
      // Record that we can see other participants. Once true, the
      // optimistic self-key timer above will not fire.
      if (participants.length > 1) rosterSeenMultipleRef.current = true;
      const signed: voiceE2ee.SignedVoiceParticipant[] = participants
        .filter((p) => p.joinBlob && p.signature)
        .map((p) => ({
          userId: p.userId,
          blob: p.joinBlob as voiceE2ee.SignedVoiceJoinBlob,
          signature: p.signature as string,
          // Server-claimed key; selectSignedLeader pins/verifies it (falls back
          // to blob.sigPub for legacy participants without this field).
          signingPublicKey: p.signingPublicKey,
        }));
      // Cache the verified roster so a leader-departure backstop can
      // re-run election without waiting for a fresh voice-participants event.
      lastSignedRef.current = signed;
      const myElection = ++electionSeqRef.current;
      const electedUserId = await voiceE2ee.selectSignedLeader(chId, signed, resolveTrustedSigningKey);
      // Drop stale results: the session changed (leave/rejoin) or a newer roster
      // superseded this election while the async pin lookup was in flight.
      if (sessionNonceRef.current !== myNonce || electionSeqRef.current !== myElection) return;
      if (electedUserId === verifiedLeaderRef.current) return;
      verifiedLeaderRef.current = electedUserId;

      if (electedUserId === currentUserId) {
        isLeaderRef.current = true;
      } else if (electedUserId && isLeaderRef.current && participants.length > 1) {
        // Someone with an earlier verified joinTimestamp is the true leader:
        // step down and ask them for the real key.
        isLeaderRef.current = false;
        const pubKey = voiceE2ee.getPublicKeyBase64();
        if (pubKey) {
          socketService.emitVoiceE2eeRequestKey({
            channelId: chId,
            publicKey: pubKey,
            targetUserId: electedUserId,
          });
        }
      }
    });

    socketService.onVoiceE2eeKey((data) => {
      if (data.channelId !== channelIdRef.current) return;
      if (sessionNonceRef.current !== myNonce) return;
      // Drop unknown key formats — never throw. Peer on a newer protocol will
      // re-encode if it can degrade, or both sides fall back on reconnect.
      if (!isSupportedKeyFormat(data.keyFormat)) {
        logger.warn('[voice-e2ee] unknown keyFormat, ignoring', { format: data.keyFormat, channelId: data.channelId });
        return;
      }
      // Gate: once we have a verified leader, keys from anyone else are rejected.
      // Before any signed blobs arrive (legacy peers) we accept server-attested.
      if (verifiedLeaderRef.current && data.leaderUserId !== verifiedLeaderRef.current) {
        return;
      }
      // Decrypt with the elected leader's signature-verified blob.pub, not the
      // server-supplied data.leaderPublicKey: the userId gate alone only proves
      // the server named the right leader, so without this it could swap in its
      // own wrap key. See resolveLeaderWrapKey.
      const wrapKey = voiceE2ee.resolveLeaderWrapKey(
        verifiedLeaderRef.current,
        lastSignedRef.current,
        data.leaderPublicKey,
      );
      if (!wrapKey) return; // verified leader but its signed blob isn't cached → wait for the next roster
      const key = voiceE2ee.decryptVoiceKeyFromLeader(
        data.encryptedKey,
        data.nonce,
        wrapKey,
      );
      if (key) {
        clearTimeout(optimisticTimer);
        // A real key arrived — the leader is alive; cancel the backstop.
        if (leaderLivenessTimerRef.current) {
          clearTimeout(leaderLivenessTimerRef.current);
          leaderLivenessTimerRef.current = null;
        }
        isLeaderRef.current = false;
        voiceE2ee.setVoiceKey(data.channelId, key);
        stableSetE2eeKey(key);
      }
    });

    socketService.onVoiceE2eeRequestKey((data) => {
      if (data.channelId !== channelIdRef.current || !isLeaderRef.current) return;
      if (sessionNonceRef.current !== myNonce) return;
      const sessionKey = voiceE2ee.getVoiceKey();
      if (!sessionKey) return;
      const recipientPub = voiceE2ee.publicKeyFromBase64(data.publicKey);
      const result = voiceE2ee.encryptVoiceKeyForParticipant(sessionKey, recipientPub);
      if (result) {
        const keyFormat = selectSframeDialect([...KNOWN_CAPABILITIES], data.capabilities);
        socketService.emitVoiceE2eeDistribute({
          channelId: data.channelId,
          targetUserId: data.userId,
          encryptedKey: result.encrypted,
          nonce: result.nonce,
          keyFormat,
        });
      }
    });

    const clearLivenessTimer = () => {
      if (leaderLivenessTimerRef.current) {
        clearTimeout(leaderLivenessTimerRef.current);
        leaderLivenessTimerRef.current = null;
      }
    };

    socketService.onVoiceE2eeRotate((data) => {
      if (data.channelId !== channelIdRef.current) return;
      if (sessionNonceRef.current !== myNonce) return;
      // A real rotate arrived — cancel any pending liveness backstop.
      clearLivenessTimer();
      // Prefer locally-verified election over server-chosen newLeaderUserId.
      const electedUserId = verifiedLeaderRef.current ?? data.newLeaderUserId;
      if (electedUserId === currentUserId) {
        isLeaderRef.current = true;
        const newKey = voiceE2ee.generateVoiceSessionKey();
        voiceE2ee.setVoiceKey(data.channelId, newKey);
        stableSetE2eeKey(newKey);
      } else {
        isLeaderRef.current = false;
        const pubKey = voiceE2ee.getPublicKeyBase64();
        if (pubKey && channelIdRef.current) {
          socketService.emitVoiceE2eeRequestKey({
            channelId: channelIdRef.current,
            publicKey: pubKey,
            targetUserId: electedUserId,
          });
        }
      }
    });

    // Client-side liveness backstop. The keying scheme relies on the
    // server emitting voice-e2ee-rotate to recover from a key-holder departure.
    // If that event is dropped (Socket.IO drops in-flight events during a
    // reconnect window) or never sent, the channel would sit on a stale key
    // held by a departed leader with nothing to repair it. When the *verified*
    // leader departs, schedule a short timer; if no rotate/fresh key arrives,
    // re-run election locally against the cached roster (minus the departed
    // leader) and either assume leadership or request the key from the new
    // leader — making recovery independent of the single server event.
    const LEADER_LIVENESS_GRACE_MS = 1_500;
    const handleVoiceUserLeft = (data: { userId: string }) => {
      if (sessionNonceRef.current !== myNonce) return;
      const departedUserId = data.userId;
      if (!departedUserId) return;
      // Prune the departed participant from the cached roster for EVERY
      // departure, not just the leader's. The backstop below re-elects from
      // lastSignedRef minus the departed leader; if a non-leader who already
      // left is still in the roster, selectSignedLeader can elect that ghost,
      // verifiedLeaderRef gets poisoned, and onVoiceE2eeRotate + the
      // voice-e2ee-key gate then reject every legitimate key — wedging this
      // client on a stale key for the rest of the session. lastSignedRef is
      // otherwise only refreshed by voice-participants (join/profile-update),
      // never on a leave, so this is the only place a leave updates it.
      lastSignedRef.current = lastSignedRef.current.filter((p) => p.userId !== departedUserId);
      if (departedUserId !== verifiedLeaderRef.current) return;
      if (leaderLivenessTimerRef.current) return; // already scheduled
      leaderLivenessTimerRef.current = setTimeout(async () => {
        leaderLivenessTimerRef.current = null;
        if (sessionNonceRef.current !== myNonce) return;
        const chId = channelIdRef.current;
        if (!chId) return;
        // The server rotate would have cleared this timer; reaching here means
        // it never arrived. Re-elect from the cached roster. handleVoiceUserLeft
        // already pruned the departed leader (and any earlier-departed peers),
        // so this extra filter is just defensive belt-and-suspenders.
        const candidates = lastSignedRef.current.filter((p) => p.userId !== departedUserId);
        const elected = await voiceE2ee.selectSignedLeader(chId, candidates, resolveTrustedSigningKey);
        if (sessionNonceRef.current !== myNonce) return; // re-check after the async pin lookup
        // No verifiable successor — fall back to current participant set's
        // server-attested order is unavailable here; leave the key as-is and
        // wait for the next roster/rotate rather than adopt an unverified key.
        if (!elected) return;
        verifiedLeaderRef.current = elected;
        if (elected === currentUserId) {
          isLeaderRef.current = true;
          const newKey = voiceE2ee.generateVoiceSessionKey();
          voiceE2ee.setVoiceKey(chId, newKey);
          stableSetE2eeKey(newKey);
        } else {
          isLeaderRef.current = false;
          const pubKey = voiceE2ee.getPublicKeyBase64();
          if (pubKey) {
            socketService.emitVoiceE2eeRequestKey({
              channelId: chId,
              publicKey: pubKey,
              targetUserId: elected,
            });
          }
        }
      }, LEADER_LIVENESS_GRACE_MS);
    };
    // Additive raw listener (named handler so cleanup removes only ours),
    // mirroring addVoiceParticipantsListener. Same caveat as that listener:
    // useCallSession's transport teardown calls socketService.offVoice() which
    // blanket-clears `voice-user-left`; if that engine effect re-runs mid-call
    // (e.g. screenShareCodec change) without this hook's effect re-running,
    // the backstop is dropped. That trigger is rare and the server
    // rotates are the primary recovery — this listener is the secondary net.
    socketService.socket?.on('voice-user-left', handleVoiceUserLeft);

    return () => {
      clearTimeout(optimisticTimer);
      clearLivenessTimer();
      socketService.socket?.off('voice-user-left', handleVoiceUserLeft);
      unsubscribeParticipants();
      socketService.offVoiceE2eeKey();
      socketService.offVoiceE2eeRequestKey();
      socketService.offVoiceE2eeRotate();
      voiceE2ee.clearVoiceKey();
      isLeaderRef.current = false;
      verifiedLeaderRef.current = null;
    };
  }, [channelId, currentUserId, stableSetE2eeKey]);
}
