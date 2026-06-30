// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Server-side voice-leader election.
 *
 * The client elects the voice key-holder by the SIGNED `joinTimestamp` carried
 * in each participant's join-blob (`services/voiceE2ee.ts#selectSignedLeader`),
 * but the server used to authorize the key-holder strictly by `participants[0]`
 * ordered on server-side `joinedAt` (the Redis arrival order). Those two
 * orderings can flip relative order under ordinary client clock drift (the
 * ±30s join clamp bounds each blob's absolute skew but never the *relative*
 * order of two joiners), so the server-allowed leader's key is rejected by
 * every client while the client-elected leader's distribution is dropped by the
 * server — no SFrame key is ever accepted and the call wedges with no recovery.
 *
 * This helper re-derives the leader on the server using the SAME rule the
 * client uses, so the server's key-distribution authority and the client's
 * key-accept gate converge by construction:
 *   - among participants whose stored join-blob VERIFIES (re-checked here with
 *     the identical gate the client applies: signature valid under the
 *     DB-authoritative signing key, and `blob.sigPub` matching it), pick the
 *     earliest `joinTimestamp`, ties broken by lex-smaller X25519 `pub`;
 *   - if NO participant carries a verifying blob (all legacy/locked-vault),
 *     fall back to the server-attested oldest by `joinedAt` — which is exactly
 *     what the client falls back to when its own election returns null.
 *
 * The server already verifies + stores each blob at join time
 * (`voice.ts` join-blob gate → `addVoiceParticipant`), so this introduces no new
 * trust in client-asserted data; it only reuses the stored, already-verified
 * `joinTimestamp` for ordering. Re-verifying here (rather than trusting blob
 * presence) guarantees the server's "verified" set is byte-identical to the
 * client's, so the two can never diverge even if a future change stored an
 * unvetted blob.
 */
import nacl from 'tweetnacl';

type SignedVoiceJoinBlob = { v: 1; channelId: string; joinTimestamp: number; pub: string; sigPub: string };

export interface ElectableParticipant {
  userId: string;
  joinBlob?: SignedVoiceJoinBlob;
  signature?: string;
  signingPublicKey?: string;
  joinedAt?: number;
}

/**
 * Mirror of the client's `verifyVoiceJoinBlob` (services/dmKeyManager.ts):
 * when a DB-authoritative signing key is known, require `blob.sigPub` to match
 * it and verify the signature under it; otherwise fall back to `blob.sigPub`.
 * Returns false on any failure.
 */
function blobVerifies(
  channelId: string,
  blob: SignedVoiceJoinBlob | undefined,
  signature: string | undefined,
  trustedSigPubB64: string | undefined,
): boolean {
  if (!blob || !signature) return false;
  if (blob.channelId !== channelId) return false;
  const verifyingKeyB64 = trustedSigPubB64 ?? blob.sigPub;
  if (trustedSigPubB64 && blob.sigPub !== trustedSigPubB64) return false;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(blob));
    return nacl.sign.detached.verify(bytes, Buffer.from(signature, 'base64'), Buffer.from(verifyingKeyB64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Elect the voice leader for `channelId` from its participant set, matching the
 * client's `selectSignedLeader`. Returns the leader userId, or null if the set
 * is empty.
 */
export function electVoiceLeader(channelId: string, participants: ElectableParticipant[]): string | null {
  if (participants.length === 0) return null;

  const verified = participants.filter((p) => blobVerifies(channelId, p.joinBlob, p.signature, p.signingPublicKey));
  if (verified.length > 0) {
    verified.sort((a, b) => {
      const ta = a.joinBlob!.joinTimestamp;
      const tb = b.joinBlob!.joinTimestamp;
      if (ta !== tb) return ta - tb;
      const pa = a.joinBlob!.pub;
      const pb = b.joinBlob!.pub;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    return verified[0].userId;
  }

  // No verifying blob anywhere — server-attested oldest by joinedAt (treat a
  // missing joinedAt as 0/oldest, matching redis.ts#sortVoiceParticipantsByJoinedAt;
  // first-wins on a tie preserves that stable order). This is the same
  // server-attested leader the client accepts when its election returns null.
  let best = participants[0];
  for (const p of participants) {
    if ((p.joinedAt ?? 0) < (best.joinedAt ?? 0)) best = p;
  }
  return best.userId;
}
