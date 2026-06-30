// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef, useCallback } from 'react';
import { socketService } from '../services/socket';
import * as stageE2ee from '../services/stageE2ee';
import { fromBase64 } from '../services/cryptoHelpers';
import { apiClient } from '../services/api';
import { useVoiceStore } from '../stores/voiceStore';
import { selectSframeDialect, isSupportedKeyFormat } from '../services/peerDialects';
import { KNOWN_CAPABILITIES } from '../shared/protocol';
import { logger } from '../services/logger';
import * as mlsGroupStore from '../services/mls/mlsGroupStore';

/**
 * Stage E2EE key exchange hook.
 *
 * Orchestrates the SFrame key exchange protocol for stage channels:
 * - When joining: sends public key, listens for encrypted key from host
 * - When you're the host/moderator: generates session key, distributes to new speakers
 * - On rotation (speaker leaves): new host generates fresh key and distributes
 *
 * Key holder is the host (stage starter) or a moderator, not the oldest participant.
 */
export function useStageE2ee(
  channelId: string | null,
  currentUserId: string | null,
  hostUserId: string | null,
  setE2eeKey: ((key: Uint8Array) => Promise<void>) | null,
): void {
  const isHostRef = useRef(false);
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  // True once we (as a non-host) have adopted the host's key. Gates
  // the audience-side request/retry so we stop asking once keyed.
  const keyReceivedRef = useRef(false);
  // Bounded retry timer for the audience-side key request.
  const keyRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Expected key-distributor identity. Seeded to `hostUserId` (the
  // session starter) on effect-mount and advanced on every `stage-e2ee-rotate`.
  // Incoming `stage-e2ee-key` events whose `hostUserId` doesn't match are
  // rejected — prevents any promoted speaker (including a low-trust audience
  // member who raised their hand) from hijacking our SFrame session key.
  const verifiedHostRef = useRef<string | null>(null);

  const stableSetE2eeKey = useCallback(
    (key: Uint8Array) => setE2eeKey?.(key),
    [setE2eeKey],
  );

  useEffect(() => {
    // Stage join is gated on ensureE2eUnlockedForCall() — the vault is
    // guaranteed unlocked by the time channelId is set.
    if (!channelId || !currentUserId) return;

    const isHost = stageE2ee.isHostOrModerator(currentUserId, hostUserId ?? undefined);
    isHostRef.current = isHost;
    // Seed verified host from the session's startedById on join;
    // updated as stage-e2ee-rotate events arrive. Reset here so switching
    // stages mid-session doesn't carry the previous stage's leader over.
    verifiedHostRef.current = hostUserId ?? null;
    // Reset per-session key-receipt + retry state (rapid leave+rejoin).
    keyReceivedRef.current = isHost; // host already holds the key
    if (keyRequestTimerRef.current) { clearTimeout(keyRequestTimerRef.current); keyRequestTimerRef.current = null; }
    // Publish the audience/speaker key-readiness so useStageRoom can
    // render an amber "key not yet arrived" shield until the host's key lands.
    useVoiceStore.getState().setStageE2eeKeyed(channelId, isHost);

    // Audience/non-host key request with bounded backoff. If the host's proactive push was
    // lost (Socket.IO drop, host mid-reconnect, host abrupt-leave) the joiner
    // sat silently on its optimistic self-key with no way to ask again. We
    // ask the server to re-trigger distribution from the current leader, and
    // retry a few times with growing delays until a key arrives.
    const REQUEST_DELAYS_MS = [3_000, 5_000, 8_000];
    let requestAttempt = 0;
    const scheduleKeyRequest = () => {
      if (keyRequestTimerRef.current) { clearTimeout(keyRequestTimerRef.current); keyRequestTimerRef.current = null; }
      if (requestAttempt >= REQUEST_DELAYS_MS.length) return;
      const delay = REQUEST_DELAYS_MS[requestAttempt];
      keyRequestTimerRef.current = setTimeout(() => {
        keyRequestTimerRef.current = null;
        if (keyReceivedRef.current || isHostRef.current) return;
        const chId = channelIdRef.current;
        const pubKey = stageE2ee.getPublicKeyBase64();
        if (chId && pubKey) {
          const keyFormat = selectSframeDialect([...KNOWN_CAPABILITIES], undefined);
          socketService.emitStageE2eeRequestKey({
            channelId: chId,
            publicKey: pubKey,
            capabilities: [keyFormat],
          });
        }
        requestAttempt += 1;
        scheduleKeyRequest();
      }, delay);
    };

    if (isHost) {
      // Host: reuse the key seeded by useStageRoom during render (or generate
      // if missing) and apply to the engine. Reusing the render-time seed
      // keeps the host's key stable across StrictMode double-invokes and
      // matches the key the engine was constructed with.
      let initialKey = stageE2ee.getStageKey();
      if (!initialKey || stageE2ee.getStageChannelId() !== channelId) {
        initialKey = stageE2ee.generateStageSessionKey();
        stageE2ee.setStageKey(channelId, initialKey);
      }
      stableSetE2eeKey(initialKey);
    } else {
      // Non-host: wait for the host's stage-e2ee-key push, with the request/
      // retry backstop above in case it never arrives.
      scheduleKeyRequest();
    }

    // Resolve a peer's signing key via the client's TOFU pin store (the shared
    // MLS AIK store), not the server key: first sight pins, a later mismatch
    // returns null. Fails closed on error.
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

    // Listen for key from host (when joining as non-host, or after rotation)
    socketService.onStageE2eeKey(async (data) => {
      if (data.channelId !== channelIdRef.current) return;
      // Drop unknown key formats — never throw. Peer on a newer protocol will
      // re-encode if it can degrade, or both sides fall back on reconnect.
      if (!isSupportedKeyFormat(data.keyFormat)) {
        logger.warn('[stage-e2ee] unknown keyFormat, ignoring', { format: data.keyFormat, channelId: data.channelId });
        return;
      }
      // Refuse keys from anyone other than the currently-verified
      // host. Before we have any host context (verifiedHostRef.current is
      // null) we accept the server's assertion — this is the bootstrap
      // case where the stage session just started and we haven't received
      // the session payload yet. Once we've locked in a host we only
      // accept rotation via the server's stage-e2ee-rotate event.
      if (verifiedHostRef.current && data.hostUserId !== verifiedHostRef.current) {
        logger.warn('[stage-e2ee] rejecting key from non-host', { channelId: data.channelId });
        return;
      }
      // Verify the host's signed attestation against its pinned AIK and decrypt
      // with the wrap key bound in it — never the server-supplied
      // `hostPublicKey`. A missing/forged/substituted attestation fails closed
      // (audience stays unkeyed and retries).
      const verifiedHostPub = await stageE2ee.verifySignedHost(
        data.channelId,
        data.hostUserId,
        data.hostBlob,
        data.hostSignature,
        resolveTrustedSigningKey,
      );
      if (!verifiedHostPub) {
        logger.warn('[stage-e2ee] host attestation failed — rejecting key', { channelId: data.channelId });
        return;
      }
      if (data.channelId !== channelIdRef.current) return; // re-check after the async verify
      const key = stageE2ee.decryptStageKeyFromHost(
        data.encryptedKey,
        data.nonce,
        verifiedHostPub,
      );
      if (key) {
        isHostRef.current = false;
        verifiedHostRef.current = data.hostUserId;
        // Keyed; stop the audience-side request/retry loop.
        keyReceivedRef.current = true;
        if (keyRequestTimerRef.current) { clearTimeout(keyRequestTimerRef.current); keyRequestTimerRef.current = null; }
        useVoiceStore.getState().setStageE2eeKeyed(data.channelId, true);
        stageE2ee.setStageKey(data.channelId, key);
        stableSetE2eeKey(key);
      }
    });

    // Listen for rotation (speaker left, new host selected)
    socketService.onStageE2eeRotate((data) => {
      if (data.channelId !== channelIdRef.current) return;
      // Advance the verified host pointer BEFORE any new
      // stage-e2ee-key event arrives so the key from the new host is
      // accepted and keys from a racing old host are rejected.
      verifiedHostRef.current = data.newHostUserId;
      if (data.newHostUserId === currentUserId) {
        // We're the new host: generate a fresh key, apply to our engine,
        // and fan it out to every remaining speaker + audience member.
        // Previously this relied on future stage-speaker-added events to
        // distribute — which meant existing speakers and all audience
        // members were stranded on the previous (now forward-secrecy-
        // rotated) key and silently lost decode for the rest of the
        // session. Rotation MUST redistribute to everyone present.
        isHostRef.current = true;
        // We now hold the (freshly generated) key.
        keyReceivedRef.current = true;
        if (keyRequestTimerRef.current) { clearTimeout(keyRequestTimerRef.current); keyRequestTimerRef.current = null; }
        useVoiceStore.getState().setStageE2eeKeyed(data.channelId, true);
        const newKey = stageE2ee.generateStageSessionKey();
        stageE2ee.setStageKey(data.channelId, newKey);
        stableSetE2eeKey(newKey);
        distributeStageKeyToAll(data.channelId, newKey, currentUserId);
      } else {
        isHostRef.current = false;
        // Wait for the new host to distribute the key. The audience-side
        // request/retry backstop (below) recovers if that push is lost. Until
        // the new key lands we no longer hold a verified key → amber.
        keyReceivedRef.current = false;
        useVoiceStore.getState().setStageE2eeKeyed(data.channelId, false);
        requestAttempt = 0;
        scheduleKeyRequest();
      }
    });

    // Host distributes the current session key to any participant that
    // has just joined the stage — speakers AND audience. Audience members
    // need the key to decode speakers' SFrame-encrypted audio; without
    // this handler the stage is a silent room for everyone in the crowd.
    // We listen directly on the raw socket to avoid interfering with the
    // application-level listeners in useStageSocketEvents (which use the
    // replacing `onStage*` helpers and would clobber each other).
    const sendKeyTo = (targetUserId: string, targetChannelId: string) => {
      if (!isHostRef.current) return;
      if (targetChannelId !== channelIdRef.current) return;
      if (targetUserId === currentUserId) return;
      const sessionKey = stageE2ee.getStageKey();
      if (!sessionKey) return;
      apiClient.getDmKeysPublicKey(targetUserId).then(({ publicKey }) => {
        const recipientPub = fromBase64(publicKey);
        const result = stageE2ee.encryptStageKeyForParticipant(sessionKey, recipientPub);
        if (result) {
          // Stage events (stage-speaker-added / stage-audience-joined) don't
          // carry peer capabilities — the host distributes proactively, not via
          // request-key. Falls back to sframe.v1 until stages propagate caps.
          const keyFormat = selectSframeDialect([...KNOWN_CAPABILITIES], undefined);
          // Sign a host attestation so the recipient can verify us against a
          // pinned AIK instead of the server-attested host.
          const host = stageE2ee.buildOwnSignedHostBlob(targetChannelId);
          socketService.emitStageE2eeDistribute({
            channelId: targetChannelId,
            targetUserId,
            encryptedKey: result.encrypted,
            nonce: result.nonce,
            keyFormat,
            ...(host ? { hostBlob: host.blob, hostSignature: host.signature } : {}),
          });
        }
      }).catch(() => {
        // Participant doesn't have Secure DMs set up — degrade gracefully
      });
    };

    const handleSpeakerAdded = (data: { channelId: string; userId: string }) => {
      sendKeyTo(data.userId, data.channelId);
    };
    const handleAudienceJoined = (data: { userId: string; channelId: string }) => {
      sendKeyTo(data.userId, data.channelId);
    };

    socketService.socket?.on('stage-speaker-added', handleSpeakerAdded);
    socketService.socket?.on('stage-audience-joined', handleAudienceJoined);

    // Host side of the audience key-request. The server routes a
    // requester's `stage-e2ee-request-key` to the current leader; the host
    // re-distributes the session key to that participant. `sendKeyTo` re-gates
    // on isHostRef + looks up the requester's DB public key, so a non-host
    // ignores this and can't be coerced into distributing.
    socketService.onStageE2eeRequestKey((data) => {
      sendKeyTo(data.userId, data.channelId);
    });

    return () => {
      socketService.offStageE2eeKey();
      socketService.offStageE2eeRotate();
      socketService.offStageE2eeRequestKey();
      socketService.socket?.off('stage-speaker-added', handleSpeakerAdded);
      socketService.socket?.off('stage-audience-joined', handleAudienceJoined);
      if (keyRequestTimerRef.current) { clearTimeout(keyRequestTimerRef.current); keyRequestTimerRef.current = null; }
      if (channelId) useVoiceStore.getState().setStageE2eeKeyed(channelId, false);
      stageE2ee.clearStageKey();
      isHostRef.current = false;
      verifiedHostRef.current = null;
      keyReceivedRef.current = false;
    };
  }, [channelId, currentUserId, hostUserId, stableSetE2eeKey]);
}

/**
 * Distribute a stage session key to every current speaker + audience member.
 * Called when the host rotates the key — e.g. the previous host/speaker
 * left the stage and forward secrecy requires every participant to switch
 * to the new key.
 *
 * Participant list is read from the voice store, which is kept in sync with
 * the stage session REST snapshot + incremental socket updates. Any public
 * key lookup failure degrades gracefully (that participant simply can't
 * decode until the next rotation).
 */
function distributeStageKeyToAll(channelId: string, sessionKey: Uint8Array, selfUserId: string): void {
  const session = useVoiceStore.getState().activeStageSessions[channelId];
  if (!session) return;
  const targetIds = new Set<string>();
  for (const s of session.speakers) targetIds.add(s.userId);
  for (const a of session.audienceMembers ?? []) targetIds.add(a.userId);
  targetIds.delete(selfUserId);
  if (targetIds.size === 0) return;

  for (const targetUserId of targetIds) {
    apiClient.getDmKeysPublicKey(targetUserId).then(({ publicKey }) => {
      const recipientPub = fromBase64(publicKey);
      const result = stageE2ee.encryptStageKeyForParticipant(sessionKey, recipientPub);
      if (result) {
        // Stage rotation distributes to all — no per-peer capabilities available.
        const keyFormat = selectSframeDialect([...KNOWN_CAPABILITIES], undefined);
        // Sign a host attestation so each recipient can verify our identity
        // against a pinned AIK rather than the server-attested host.
        const host = stageE2ee.buildOwnSignedHostBlob(channelId);
        socketService.emitStageE2eeDistribute({
          channelId,
          targetUserId,
          encryptedKey: result.encrypted,
          nonce: result.nonce,
          keyFormat,
          ...(host ? { hostBlob: host.blob, hostSignature: host.signature } : {}),
        });
      }
    }).catch(() => {
      // Participant doesn't have Secure DMs set up — degrade gracefully
    });
  }
}
