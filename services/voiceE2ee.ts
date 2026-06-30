// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Voice channel E2EE key management.
 * Oldest participant = key holder (leader). Generates and distributes SFrame session keys.
 * Key rotates on any participant leave.
 *
 * Leader election runs on *signed* join-blobs broadcast by every client. Each
 * client verifies peer signatures against the peer's identity key (AIK) pinned
 * in its own TOFU trust store (the store MLS uses) — not the key the server
 * supplies — and picks the lowest verified joinTimestamp (ties broken by
 * lex-smaller X25519 pub). A peer whose key fails the pin is dropped, so the
 * server can't substitute a signing key to steer election.
 */
import { generateChannelKey } from './dmCrypto';
import * as dmKeyManager from './dmKeyManager';
import { fromBase64, zeroFill } from './cryptoHelpers';

let _currentVoiceKey: Uint8Array | null = null;
let _currentChannelId: string | null = null;

/** Generate a fresh 32-byte SFrame session key for a voice channel. */
export function generateVoiceSessionKey(): Uint8Array {
  return generateChannelKey(); // reuses the 32-byte random generator
}

/** Get current voice E2EE key bytes (for passing to CallEngine). */
export function getVoiceKey(): Uint8Array | null {
  return _currentVoiceKey;
}

export function getVoiceChannelId(): string | null {
  return _currentChannelId;
}

/** Encrypt the voice session key for a specific participant using their public key. */
export function encryptVoiceKeyForParticipant(
  sessionKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): { encrypted: string; nonce: string } | null {
  return dmKeyManager.encryptKeyForRecipient(sessionKey, recipientPublicKey);
}

/** Decrypt a voice session key received from the leader. */
export function decryptVoiceKeyFromLeader(
  encryptedKey: string,
  nonce: string,
  leaderPublicKey: string,
): Uint8Array | null {
  return dmKeyManager.decryptKeyFromSender(encryptedKey, nonce, leaderPublicKey);
}

/**
 * Pick the X25519 key to decrypt an inbound session key with: the elected
 * leader's signature-verified `blob.pub`, never the server-supplied wire key —
 * so a server that keeps the real leaderUserId but swaps in its own wrap key
 * can't get its ciphertext to open. Falls back to the server key only before a
 * leader is verified (bootstrap / legacy peers); returns null (fail closed)
 * when the verified leader's blob isn't cached yet.
 */
export function resolveLeaderWrapKey(
  verifiedLeaderUserId: string | null,
  cachedRoster: SignedVoiceParticipant[],
  serverSuppliedKey: string,
): string | null {
  if (!verifiedLeaderUserId) return serverSuppliedKey;
  const verified = cachedRoster.find((p) => p.userId === verifiedLeaderUserId);
  return verified ? verified.blob.pub : null;
}

/** Set the current voice E2EE key (after decrypting from leader or generating as leader). */
export function setVoiceKey(channelId: string, key: Uint8Array): void {
  _currentVoiceKey = key;
  _currentChannelId = channelId;
}

/** Clear voice E2EE state (on leave). Zeros key bytes before releasing. */
export function clearVoiceKey(): void {
  zeroFill(_currentVoiceKey);
  _currentVoiceKey = null;
  _currentChannelId = null;
}

/** Check if the current user is the oldest participant (leader). */
export function isOldestParticipant(currentUserId: string, participantUserIds: string[], oldestUserId?: string): boolean {
  if (oldestUserId) return currentUserId === oldestUserId;
  // Fallback: first in the list is oldest (server should sort by join time)
  return participantUserIds[0] === currentUserId;
}

/** Canonical shape of a voice-leader join-blob: signed + transported as-is
 *  to every peer, verified locally, never interpreted by the server. */
export interface SignedVoiceJoinBlob {
  v: 1;
  channelId: string;
  joinTimestamp: number;
  pub: string;
  sigPub: string;
}

export interface SignedVoiceParticipant {
  userId: string;
  blob: SignedVoiceJoinBlob;
  signature: string;
  /** Ed25519 key the server claims for this participant. Not trusted directly:
   *  `selectSignedLeader` verifies the blob against the peer's pinned AIK (TOFU).
   *  Absent for legacy participants — then `blob.sigPub` is pinned instead. */
  signingPublicKey?: string;
}

/** Resolve a peer's pinned (TOFU) Ed25519 AIK from the claimed key: returns the
 *  key to verify against, or null on a pin mismatch (server substitution). */
export type TrustedSigningKeyResolver = (
  userId: string,
  claimedSigPubB64: string,
) => Promise<string | null>;

/** Pick the leader: earliest verified joinTimestamp, ties broken by lex-smaller
 *  X25519 pub. Each blob is verified against the peer's pinned AIK; a pin
 *  mismatch drops the peer. Null → none verify, so the caller keeps its key. */
export async function selectSignedLeader(
  channelId: string,
  participants: SignedVoiceParticipant[],
  resolveTrustedSigningKey: TrustedSigningKeyResolver,
): Promise<string | null> {
  const verified: SignedVoiceParticipant[] = [];
  for (const p of participants) {
    if (p.blob.channelId !== channelId) continue;
    // The key the server claims for this peer is only a *candidate*: pin/verify
    // it against the client's own trust store before trusting the signature.
    const claimed = p.signingPublicKey ?? p.blob.sigPub;
    const trusted = await resolveTrustedSigningKey(p.userId, claimed);
    if (!trusted) continue; // pin mismatch (server substitution) → drop peer
    if (!dmKeyManager.verifyVoiceJoinBlob(p.blob, p.signature, trusted)) continue;
    verified.push(p);
  }
  if (verified.length === 0) return null;

  verified.sort((a, b) => {
    if (a.blob.joinTimestamp !== b.blob.joinTimestamp) {
      return a.blob.joinTimestamp - b.blob.joinTimestamp;
    }
    return a.blob.pub < b.blob.pub ? -1 : a.blob.pub > b.blob.pub ? 1 : 0;
  });

  return verified[0].userId;
}

/** Build this user's own signed join-blob. Null if the signing key is not
 *  loaded (user has not unlocked Secure DMs yet). */
export function buildOwnSignedJoinBlob(channelId: string, joinTimestamp: number): {
  blob: SignedVoiceJoinBlob;
  signature: string;
} | null {
  return dmKeyManager.signVoiceJoinBlob(channelId, joinTimestamp);
}

/** Get the user's public key as base64 (for sending to other participants). */
export function getPublicKeyBase64(): string | null {
  return dmKeyManager.getPublicKey();
}

/** Convert a base64-encoded public key to Uint8Array. */
export function publicKeyFromBase64(b64: string): Uint8Array {
  return fromBase64(b64);
}
