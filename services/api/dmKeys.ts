// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

// Types

export interface DmKeyBundle {
  publicKey: string;
  /** Ed25519 public key. Nullable for bundles predating the
   *  signing-key rollout; clients lazily generate + upload one on next unlock. */
  signingPublicKey?: string | null;
  encryptedBlob: string;
  blobSalt: string;
  blobVersion: number;
  recoveryBlob: string;
  recoveryNonce: string;
  recoveryMode?: 'key' | 'passphrase' | 'server-escrowed' | null;
  recoveryPassphraseSalt?: string | null;
  passwordDerived?: boolean;
}

/** One predecessor-signed AIK rotation hop (see services/mls/aikRotation). */
export interface AikRotationLink {
  seq: number;
  oldAik: string;
  newAik: string;
  signature: string;
}

/** The signed current-head attestation (anti-rollback freshness anchor). */
export interface AikHeadAttestation {
  seq: number;
  aik: string;
  signature: string;
}

/** A single sealed row uploaded to the cross-device history archive.
 *  The server stores `ciphertext` opaquely; it never reads the plaintext. */
export interface ArchiveItem {
  dmChannelId: string;
  envelopeHash: string;
  ciphertext: string;
  keyVersion: number;
  messageId: string;
  msgCreatedAt: string; // ISO
}

/** A sealed row returned by the archive read endpoints
 *  (`/previews` and `/:dmChannelId`). Pagination is driven by the opaque
 *  `nextCursor`, so the row id is intentionally not surfaced here. */
export interface ArchiveRow {
  dmChannelId: string;
  messageId: string;
  envelopeHash: string;
  ciphertext: string;
  keyVersion: number;
  msgCreatedAt: string;
}

// Declaration Merging

declare module './core' {
  interface APIClient {
    getDmKeyBundle(): Promise<DmKeyBundle>;
    setupDmKeys(data: { publicKey: string; signingPublicKey?: string; encryptedBlob: string; blobSalt: string; recoveryBlob: string; recoveryNonce: string; recoveryMode?: 'key' | 'passphrase' | 'server-escrowed'; recoveryPassphraseSalt?: string; passwordDerived?: boolean; rawBlobForEscrow?: string }): Promise<{ blobVersion: number }>;
    updateDmKeysBlob(data: { encryptedBlob: string; blobVersion: number; rawBlobForEscrow?: string }): Promise<{ blobVersion: number; escrowStale?: boolean }>;
    changeDmKeysPassword(data: { encryptedBlob: string; blobSalt: string; blobVersion: number; recoveryBlob: string; recoveryNonce: string; recoveryMode?: 'key' | 'passphrase' | 'server-escrowed'; recoveryPassphraseSalt?: string; signingPublicKey?: string; rawBlobForEscrow?: string }): Promise<{ blobVersion: number }>;
    recoverDmKeys(data: { encryptedBlob: string; blobSalt: string; recoveryBlob?: string; recoveryNonce?: string; recoveryMode?: 'key' | 'passphrase' | 'server-escrowed'; recoveryPassphraseSalt?: string; signingPublicKey?: string; rawBlobForEscrow?: string }): Promise<{ blobVersion: number }>;
    getDmKeysPublicKey(userId: string): Promise<{ publicKey: string; signingPublicKey?: string | null }>;
    /** One-shot endpoint for clients that already have a bundle but
     *  no signing key (legacy bundles). Lazily uploaded on next unlock. */
    updateDmKeysSigningKey(data: { signingPublicKey: string; encryptedBlob: string; blobVersion: number; rawBlobForEscrow?: string }): Promise<{ blobVersion: number }>;
    /** Move-to-Private - rotate the roaming X25519/Ed25519 identity: publish new
     *  public keys + the re-sealed blob atomically (blobVersion + signingPublicKey CAS).
     *  When rotating the Ed25519 AIK, `aikRotation`/`aikHead` carry the predecessor-signed
     *  attestation appended in the SAME transaction (the column AIK never advances without
     *  its reaching link). */
    updateDmKeysRoamingIdentity(data: { publicKey: string; signingPublicKey: string; encryptedBlob: string; blobVersion: number; rawBlobForEscrow?: string; aikRotation?: AikRotationLink; aikHead?: AikHeadAttestation }): Promise<{ blobVersion: number }>;
    /** Fetch a user's AIK rotation-attestation chain (public AIKs + detached signatures,
     *  ascending by seq, pruned server-side) so a peer can advance its pin across a
     *  legitimate rotation. Gated to users who share a DM channel and aren't blocked. */
    getAikChain(userId: string): Promise<{ chain: AikRotationLink[]; head: AikHeadAttestation | null }>;
    deleteDmKeyBundle(): Promise<{ success: boolean }>;
    enablePasswordDerived(data: { rawBlobForEscrow: string }): Promise<{ success: boolean }>;
    disablePasswordDerived(): Promise<{ success: boolean }>;
    serverRecover(data: { password: string }): Promise<{ rawBlob: string }>;
    /** Batch upsert of sealed history rows (append-only, idempotent
     *  server-side via skipDuplicates). Reads/writes are never cached. */
    postDmHistoryArchive(items: ArchiveItem[]): Promise<{ stored: number }>;
    /** Newest row per active-participant channel; cursor paginates
     *  by dmChannelId. Uncached so a fresh device reflects live server state. */
    getDmHistoryPreviews(cursor?: string): Promise<{ rows: ArchiveRow[]; nextCursor: string | null }>;
    /** Paginated full restore for one channel, newest-first. The
     *  cursor is the opaque `nextCursor` from the previous page. Uncached. */
    getDmHistoryForChannel(dmChannelId: string, cursor?: string): Promise<{ rows: ArchiveRow[]; nextCursor: string | null }>;
    /** Delete-for-everyone write-through; removes every archived
     *  revision sharing the messageId. Idempotent. */
    deleteDmHistoryArchiveMessage(dmChannelId: string, messageId: string): Promise<{ deleted: number }>;
    /** Move-to-Private - bulk-wipe the caller's entire server history archive
     *  (scoped to userId server-side). Pass the rotated archiveKey generation so the
     *  server raises its per-user minimum-acceptable keyVersion floor (rejects any
     *  later stale-generation re-upload regardless of client tab state). Returns the
     *  deleted row count. */
    deleteDmHistoryArchive(keyVersion?: number): Promise<{ deleted: number }>;
  }
}

// Implementations

APIClient.prototype.getDmKeyBundle = async function(this: APIClient): Promise<DmKeyBundle> {
  return this.request('/dms/keys/bundle');
};

APIClient.prototype.setupDmKeys = async function(this: APIClient, data) {
  return this.request('/dms/keys/setup', { method: 'POST', body: JSON.stringify(data) });
};

APIClient.prototype.updateDmKeysBlob = async function(this: APIClient, data) {
  return this.request('/dms/keys/blob', { method: 'PUT', body: JSON.stringify(data) });
};

APIClient.prototype.changeDmKeysPassword = async function(this: APIClient, data) {
  return this.request('/dms/keys/password', { method: 'PUT', body: JSON.stringify(data) });
};

APIClient.prototype.recoverDmKeys = async function(this: APIClient, data) {
  return this.request('/dms/keys/recover', { method: 'POST', body: JSON.stringify(data) });
};

APIClient.prototype.getDmKeysPublicKey = async function(this: APIClient, userId: string) {
  return this.request(`/dms/keys/public-key/${userId}`);
};

APIClient.prototype.updateDmKeysSigningKey = async function(this: APIClient, data) {
  return this.request('/dms/keys/signing-key', { method: 'PUT', body: JSON.stringify(data) });
};

APIClient.prototype.updateDmKeysRoamingIdentity = async function(this: APIClient, data) {
  return this.request('/dms/keys/roaming-identity', { method: 'PUT', body: JSON.stringify(data) });
};

APIClient.prototype.getAikChain = async function(this: APIClient, userId: string) {
  return this.request(`/dms/keys/aik-chain/${userId}`);
};

APIClient.prototype.deleteDmKeyBundle = async function(this: APIClient) {
  return this.request('/dms/keys/bundle', { method: 'DELETE' });
};

APIClient.prototype.enablePasswordDerived = async function(this: APIClient, data) {
  return this.request('/dms/keys/password-derived', { method: 'PUT', body: JSON.stringify(data) });
};

APIClient.prototype.disablePasswordDerived = async function(this: APIClient) {
  return this.request('/dms/keys/password-derived', { method: 'DELETE' });
};

APIClient.prototype.serverRecover = async function(this: APIClient, data) {
  return this.request('/dms/keys/server-recover', { method: 'POST', body: JSON.stringify(data) });
};

APIClient.prototype.postDmHistoryArchive = async function(this: APIClient, items: ArchiveItem[]) {
  return this.request('/dms/history-archive', { method: 'POST', body: JSON.stringify({ items }) });
};

APIClient.prototype.getDmHistoryPreviews = async function(this: APIClient, cursor?: string) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return this.request(`/dms/history-archive/previews${q}`);
};

APIClient.prototype.getDmHistoryForChannel = async function(this: APIClient, dmChannelId: string, cursor?: string) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return this.request(`/dms/history-archive/${dmChannelId}${q}`);
};

APIClient.prototype.deleteDmHistoryArchiveMessage = async function(this: APIClient, dmChannelId: string, messageId: string) {
  return this.request(`/dms/history-archive/${dmChannelId}/${messageId}`, { method: 'DELETE' });
};

APIClient.prototype.deleteDmHistoryArchive = async function(this: APIClient, keyVersion?: number) {
  const q = typeof keyVersion === 'number' ? `?keyVersion=${encodeURIComponent(String(keyVersion))}` : '';
  return this.request(`/dms/history-archive${q}`, { method: 'DELETE' });
};
