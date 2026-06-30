// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Pure crypto helpers for the E2EE vault, voice/stage key wrap, recovery blobs,
 * and the cross-device history archive seal.
 * No state - all functions are stateless and deterministic given inputs.
 *
 * Key derivation: Argon2id (hash-wasm)
 * Asymmetric key exchange: X25519 nacl.box (tweetnacl)
 * Symmetric encryption: AES-256-GCM (Web Crypto API)
 */
import nacl from 'tweetnacl';
import { toBase64, fromBase64, toArrayBuffer } from './cryptoHelpers';

// Types

export interface BlobContents {
  privateKey: string; // base64 - nacl.box (X25519) secret key (voice/stage wrap + blob AAD source)
  /** base64 nacl.sign (Ed25519) secret key (voice join-blob signing).
   *  Optional on legacy blobs; `dmKeyManager.unlock` lazily generates one. */
  privateSigningKey?: string;
  /** Cross-device history archive - stable per-account AES-256-GCM key (base64,
   *  32 raw bytes) sealing the server-side DmHistoryArchive rows. Never rotates
   *  on password change. NOT stripped by stripMlsForEscrow: it rides
   *  serverEscrowBlob so a server-recovered device can read the archive. */
  archiveKey?: string;
  /** Generation counter for archiveKey. 1 = original key, 2+ = rotated. Sourced
   *  into each uploaded history row's keyVersion. Absent on pre-rotation blobs
   *  (treated as 1). */
  archiveKeyVersion?: number;
}

// Key Derivation

let _argon2Worker: Worker | null = null;
let _argon2RequestId = 0;
const _argon2Pending = new Map<number, { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }>();

function getArgon2Worker(): Worker | null {
  if (_argon2Worker) return _argon2Worker;
  try {
    _argon2Worker = new Worker(
      new URL('./argon2Worker.ts', import.meta.url),
      { type: 'module' },
    );
    // Register onmessage handler ONCE for all requests
    _argon2Worker.addEventListener('message', (e: MessageEvent) => {
      const id = e.data.requestId as number;
      const pending = _argon2Pending.get(id);
      if (!pending) return;
      _argon2Pending.delete(id);
      if (e.data.error) {
        pending.reject(new Error(e.data.error));
      } else {
        pending.resolve(new Uint8Array(e.data.hash));
      }
    });
    _argon2Worker.addEventListener('error', (e: ErrorEvent) => {
      // Reject all pending requests on worker-level error
      const err = new Error(e.message ?? 'Argon2id worker error');
      for (const [id, pending] of _argon2Pending) {
        _argon2Pending.delete(id);
        pending.reject(err);
      }
    });
    return _argon2Worker;
  } catch {
    // Worker creation can fail in some environments (e.g., tests, SSR).
    // Fall back to main-thread execution.
    return null;
  }
}

async function argon2idViaWorker(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const worker = getArgon2Worker();
  if (!worker) {
    // Fallback: run on main thread if worker is unavailable. Dynamic import
    // keeps hash-wasm (~216 kB + embedded WASM) out of the main chunk — the
    // worker path below is the primary code path and it already dynamic-
    // imports hash-wasm via the Worker module boundary.
    const { argon2id } = await import('hash-wasm');
    return argon2id({
      password,
      salt,
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    });
  }
  const requestId = ++_argon2RequestId;
  return new Promise<Uint8Array>((resolve, reject) => {
    _argon2Pending.set(requestId, { resolve, reject });
    worker.postMessage({
      requestId,
      password,
      salt,
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
    });
  });
}

/**
 * Derive the legacy blob key, the MLS at-rest key, and the history key from a
 * SINGLE Argon2id pass.
 *
 * All three keys are independent AES-256-GCM keys obtained by HKDF-SHA256
 * expansion of the SAME Argon2id hash under distinct info labels with an empty
 * (deterministic) salt: `blobKey` under 'howl-blob-key' (domain separation, not
 * the raw Argon2id hash imported directly), `atRestKey` under 'howl-mls-at-rest',
 * `historyKey` under 'howl-mls-history'. The empty salt makes each derivation
 * deterministic, so the same password reproduces the same keys across unlocks
 * (the MLS group store can be decrypted on every unlock).
 *
 * Argon2id is run exactly ONCE here — never twice per unlock.
 *
 * `historyKey` is a third independent AES-256-GCM key (HKDF info
 * 'howl-mls-history') for the readable-history archive.
 */
export async function deriveUnlockMaterial(
  password: string,
  salt: Uint8Array,
): Promise<{ blobKey: CryptoKey; atRestKey: CryptoKey; historyKey: CryptoKey }> {
  const hash = await argon2idViaWorker(password, salt);
  const rawHash = toArrayBuffer(hash);
  const hkdfBase = await crypto.subtle.importKey('raw', rawHash, 'HKDF', false, ['deriveBits']);
  // blobKey gets its own HKDF domain-separation label (sibling of
  // 'howl-mls-at-rest' / 'howl-mls-history'), not the raw Argon2id hash.
  const blobBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('howl-blob-key'),
    },
    hkdfBase,
    256,
  );
  const blobKey = await crypto.subtle.importKey('raw', blobBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const atRestBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('howl-mls-at-rest'),
    },
    hkdfBase,
    256,
  );
  const atRestKey = await crypto.subtle.importKey('raw', atRestBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  // A SECOND HKDF-SHA256 from the SAME Argon2id hash (no second Argon2id pass)
  // with a distinct info label gives clean domain separation between
  // group-ratchet state (at-rest) and message plaintext (history).
  const historyBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('howl-mls-history'),
    },
    hkdfBase,
    256,
  );
  const historyKey = await crypto.subtle.importKey('raw', historyBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { blobKey, atRestKey, historyKey };
}

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

// Asymmetric Key Pair

export function generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.box.keyPair();
}

// Ed25519 signing keypair

/** Generate the per-user Ed25519 signing keypair used to sign voice/stage
 *  join blobs (`signVoiceJoinBlob`). */
export function generateSigningKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.sign.keyPair();
}

// Blob Encryption (AES-256-GCM via Web Crypto)

// Channel Key Exchange (nacl.box)

export function encryptChannelKeyForRecipient(
  channelKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): { encrypted: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(channelKey, nonce, recipientPublicKey, senderSecretKey);
  if (!encrypted) throw new Error('nacl.box encryption failed');
  return { encrypted: toBase64(encrypted), nonce: toBase64(nonce) };
}

export function decryptChannelKeyFromDelivery(
  encrypted: string,
  nonce: string,
  senderPublicKey: string,
  recipientSecretKey: Uint8Array,
): Uint8Array {
  const decrypted = nacl.box.open(
    fromBase64(encrypted),
    fromBase64(nonce),
    fromBase64(senderPublicKey),
    recipientSecretKey,
  );
  if (!decrypted) throw new Error('Failed to decrypt channel key — invalid sender or corrupted data');
  return decrypted;
}

// Recovery Key

export function generateRecoveryKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function formatRecoveryKey(key: Uint8Array): string {
  // Encode to base32, group in 4-char blocks
  let bits = '';
  for (const byte of key) bits += byte.toString(2).padStart(8, '0');
  let b32 = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    b32 += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  // Group into 4-char blocks separated by dashes
  return b32.match(/.{1,4}/g)!.join('-');
}

export function parseRecoveryKey(formatted: string): Uint8Array {
  const b32 = formatted.replace(/[-\s]/g, '').toUpperCase();
  let bits = '';
  for (const ch of b32) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid recovery key character');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

// The recovery blob is bound to the user's identity via a required AAD
// ('howl:recovery:v1:'+base64 X25519 publicKey), mirroring the packed blob's
// 'howl:blob:'+publicKey binding and the archive-row AAD. There is no AAD-less
// path — every recovery blob is identity-bound on encrypt and decrypt.
export async function encryptRecoveryBlob(
  data: BlobContents,
  recoveryKey: Uint8Array,
  aad: string,
): Promise<{ ciphertext: string; nonce: string }> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(recoveryKey), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(new TextEncoder().encode(aad)) },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return { ciphertext: toBase64(new Uint8Array(encrypted)), nonce: toBase64(nonce) };
}

export async function decryptRecoveryBlob(
  ciphertext: string,
  nonce: string,
  recoveryKey: Uint8Array,
  aad: string,
): Promise<BlobContents> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(recoveryKey), 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromBase64(nonce)), additionalData: toArrayBuffer(new TextEncoder().encode(aad)) },
    key,
    toArrayBuffer(fromBase64(ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// Cross-device history archive seal (AES-256-GCM, deterministic IV, AAD)
//
// v2 wire format: the per-row IV is HKDF-derived from the raw archiveKey + the
// unique row tuple (NOT random), so IVs are unique by construction — no birthday
// bound, no SP800-38D invocation ceiling, no counter. The AAD additionally binds
// the archive epoch (`keyVersion`), so a server that relabels a row's generation
// breaks the tag (fail-closed → live decrypt). The seal takes the RAW archiveKey
// bytes because HKDF needs the IKM. Stored row is base64(ct||tag) — NO IV prefix
// (the IV is recomputed deterministically on open).

interface ArchiveAAD {
  userId: string;
  dmChannelId: string;
  messageId: string;
  envelopeHash: string;
  /** archiveKey generation that sealed this row (anti-downgrade binding). */
  archiveEpoch: number;
}

/** Row-binding AAD so a compromised server cannot splice a valid ciphertext
 *  under a different (channel, message, envelope, epoch) tuple. */
function buildArchiveAADBytes(aad: ArchiveAAD): Uint8Array {
  return new TextEncoder().encode(
    `howl:archive:v2:${aad.userId}:${aad.dmChannelId}:${aad.messageId}:${aad.envelopeHash}:${aad.archiveEpoch}`,
  );
}

/** Derive a deterministic 96-bit GCM IV from the raw archiveKey and the unique
 *  row tuple. Within one key generation the (userId, dmChannelId,
 *  messageId, envelopeHash) tuple is unique per logical row, so IVs never collide;
 *  a rotated key changes the IKM, so cross-generation IVs differ too. The epoch is
 *  NOT folded in (the key itself differs per generation). */
async function deriveArchiveIv(archiveKeyRaw: Uint8Array, aad: ArchiveAAD): Promise<Uint8Array> {
  const hkdfBase = await crypto.subtle.importKey('raw', toArrayBuffer(archiveKeyRaw), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(
        `howl-archive-iv:v1:${aad.userId}:${aad.dmChannelId}:${aad.messageId}:${aad.envelopeHash}`,
      ),
    },
    hkdfBase,
    96,
  );
  return new Uint8Array(bits);
}

/** Seal one archive row: base64(AES-256-GCM(archiveKey, utf8(plaintext), AAD)) with
 *  a deterministic per-row IV. The 16-byte GCM tag is appended by Web Crypto. */
export async function sealArchiveRow(archiveKeyRaw: Uint8Array, plaintext: string, aad: ArchiveAAD): Promise<string> {
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(archiveKeyRaw), 'AES-GCM', false, ['encrypt']);
  const iv = await deriveArchiveIv(archiveKeyRaw, aad);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(buildArchiveAADBytes(aad)) },
    aesKey,
    toArrayBuffer(new TextEncoder().encode(plaintext)),
  );
  return toBase64(new Uint8Array(ct));
}

/** Open one archive row; throws on tag/AAD mismatch (caller must NOT persist an
 *  unverified row — it falls back to live decrypt instead). The IV is recomputed
 *  deterministically from the same inputs, so the stored blob carries no IV. */
export async function openArchiveRow(archiveKeyRaw: Uint8Array, ciphertextB64: string, aad: ArchiveAAD): Promise<string> {
  const ct = fromBase64(ciphertextB64);
  if (ct.length < 16) throw new Error('archive row too short');
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(archiveKeyRaw), 'AES-GCM', false, ['decrypt']);
  const iv = await deriveArchiveIv(archiveKeyRaw, aad);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(buildArchiveAADBytes(aad)) },
    aesKey,
    toArrayBuffer(ct),
  );
  return new TextDecoder().decode(pt);
}

// Channel Key Generation

export function generateChannelKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
