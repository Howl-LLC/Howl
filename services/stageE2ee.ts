// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Stage channel E2EE key management.
 * Host (or moderator) = key holder. Distributes SFrame session key to speakers + audience.
 * Key rotates on speaker removal only, NOT on audience leave.
 */
import { generateChannelKey } from './dmCrypto';
import * as dmKeyManager from './dmKeyManager';
import { zeroFill } from './cryptoHelpers';

let _currentStageKey: Uint8Array | null = null;
let _currentStageChannelId: string | null = null;

/** Generate a fresh 32-byte SFrame session key for a stage channel. */
export function generateStageSessionKey(): Uint8Array {
  return generateChannelKey();
}

/** Get current stage E2EE key bytes (for passing to CallEngine). */
export function getStageKey(): Uint8Array | null {
  return _currentStageKey;
}

/** Get the channel ID associated with the current stage E2EE key. */
export function getStageChannelId(): string | null {
  return _currentStageChannelId;
}

/** Set the current stage E2EE key (after decrypting from host or generating as host). */
export function setStageKey(channelId: string, key: Uint8Array): void {
  _currentStageKey = key;
  _currentStageChannelId = channelId;
}

/** Clear stage E2EE state (on leave). Zeros key bytes before releasing. */
export function clearStageKey(): void {
  zeroFill(_currentStageKey);
  _currentStageKey = null;
  _currentStageChannelId = null;
}

/**
 * Encrypt the stage session key for a specific participant.
 * Delegates to dmKeyManager.encryptKeyForRecipient().
 */
export function encryptStageKeyForParticipant(
  sessionKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): { encrypted: string; nonce: string } | null {
  return dmKeyManager.encryptKeyForRecipient(sessionKey, recipientPublicKey);
}

/**
 * Decrypt a stage session key from the host.
 * Delegates to dmKeyManager.decryptKeyFromSender().
 */
export function decryptStageKeyFromHost(
  encryptedKey: string,
  nonce: string,
  hostPublicKey: string,
): Uint8Array | null {
  return dmKeyManager.decryptKeyFromSender(encryptedKey, nonce, hostPublicKey);
}

/**
 * Check if the current user is the host or a moderator who should manage keys.
 * The host is typically the channel/server owner or the first moderator present.
 */
export function isHostOrModerator(currentUserId: string, hostUserId?: string): boolean {
  if (hostUserId) return currentUserId === hostUserId;
  return false;
}

/** Get the user's public key as base64 (for sending to other participants). */
export function getPublicKeyBase64(): string | null {
  return dmKeyManager.getPublicKey();
}

/** Stage host attestation: signed by the host, verified locally against its
 *  pinned AIK, never interpreted by the server. Binds the host's X25519 wrap key
 *  (`pub`) + AIK (`sigPub`) to the channel. */
export interface SignedStageHostBlob {
  v: 1;
  channelId: string;
  pub: string;
  sigPub: string;
}

/** Resolve a user's pinned (TOFU) Ed25519 AIK, or null on a pin mismatch
 *  (server substitution). Same contract as the voice resolver. */
export type TrustedSigningKeyResolver = (
  userId: string,
  claimedSigPubB64: string,
) => Promise<string | null>;

/** Build the host's own signed attestation. Null if the signing key isn't
 *  loaded (Secure DMs not unlocked). */
export function buildOwnSignedHostBlob(channelId: string): {
  blob: SignedStageHostBlob;
  signature: string;
} | null {
  return dmKeyManager.signStageHostBlob(channelId);
}

/** Verify a host attestation against the host's pinned AIK and return the wrap
 *  key (`blob.pub`) to decrypt with, or null if it can't be verified (missing,
 *  channel mismatch, pin mismatch, or bad signature). Decrypt with the RETURNED
 *  key, never the server-supplied `hostPublicKey`. */
export async function verifySignedHost(
  channelId: string,
  hostUserId: string,
  blob: SignedStageHostBlob | undefined,
  signature: string | undefined,
  resolveTrustedSigningKey: TrustedSigningKeyResolver,
): Promise<string | null> {
  if (!blob || !signature) return null;
  if (blob.channelId !== channelId) return null;
  const trusted = await resolveTrustedSigningKey(hostUserId, blob.sigPub);
  if (!trusted) return null; // pin mismatch (server substitution) → reject
  if (!dmKeyManager.verifyStageHostBlob(blob, signature, trusted)) return null;
  return blob.pub; // the host's verified X25519 wrap key
}
