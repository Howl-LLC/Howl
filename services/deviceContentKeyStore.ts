// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Device content-key persistence.
 *
 * Persists the three NON-EXTRACTABLE content CryptoKeys (blobKey/atRestKey/
 * historyKey from deriveUnlockMaterial) directly via IndexedDB structured
 * clone, so a passwordless boot (_installFromDeviceWrappedContentKeys) can
 * install the vault WITHOUT re-running Argon2id and WITHOUT the user's password.
 *
 * Because the keys are non-extractable, JS can USE them to decrypt the vault
 * blob / MLS store but can never read their raw bytes - a localStorage or IDB
 * record dump alone is inert. This dedicated DB is distinct from howl_e2e_wrap
 * (the legacy remember-the-password wrap key) and from the howl_mls device wrap
 * key store: it is destroyed only by an explicit clearContentKeys() (mode
 * switch / forget-device / encryption reset), NEVER by idle-lock.
 *
 * Self mode  : opt-in, 30-day SLIDING TTL (cleartext expiresAt epoch-ms).
 * Server mode: always-on, NO TTL (expiresAt = null).
 */
import { logger } from './logger';

const DB_NAME = 'howl_e2e_content_keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const RECORD_ID = 'content_keys';

const SELF_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day sliding window

export type ContentKeyMode = 'self' | 'server';

interface ContentKeyRecord {
  id: string;
  blobKey: CryptoKey;
  atRestKey: CryptoKey;
  historyKey: CryptoKey;
  mode: ContentKeyMode;
  /** Cleartext epoch-ms expiry. null = Server mode (never expires). */
  expiresAt: number | null;
}

export interface LoadedContentKeys {
  blobKey: CryptoKey;
  atRestKey: CryptoKey;
  historyKey: CryptoKey;
  mode: ContentKeyMode;
}

let _dbPromise: Promise<IDBDatabase> | null = null;

/** Test-only: drop the cached handle so a fresh IDBFactory takes effect. */
export function __resetDbHandle(): void {
  _dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function readRecord(): Promise<ContentKeyRecord | null> {
  const db = await openDb();
  return new Promise<ContentKeyRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const r = tx.objectStore(STORE_NAME).get(RECORD_ID);
    r.onsuccess = () => resolve((r.result as ContentKeyRecord) ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function writeRecord(rec: ContentKeyRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteRecord(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Persist the three content keys + mode. Self gets a 30-day sliding expiry;
 *  Server gets no expiry. Best-effort - IDB failure logs and resolves. */
export async function putContentKeys(args: {
  blobKey: CryptoKey;
  atRestKey: CryptoKey;
  historyKey: CryptoKey;
  mode: ContentKeyMode;
}): Promise<void> {
  try {
    await writeRecord({
      id: RECORD_ID,
      blobKey: args.blobKey,
      atRestKey: args.atRestKey,
      historyKey: args.historyKey,
      mode: args.mode,
      expiresAt: args.mode === 'self' ? Date.now() + SELF_TTL_MS : null,
    });
  } catch (err) {
    logger.warn('[e2e][content-keys] put failed', { error: (err as Error)?.message });
  }
}

/** Load the content keys iff present and fresh. Self mode refreshes the sliding
 *  TTL on a fresh read; an EXPIRED Self row is purged and null returned. */
export async function loadContentKeys(): Promise<LoadedContentKeys | null> {
  try {
    const rec = await readRecord();
    if (!rec) return null;
    if (rec.expiresAt !== null && Date.now() > rec.expiresAt) {
      await deleteRecord().catch(() => {});
      return null;
    }
    if (rec.mode === 'self') {
      await writeRecord({ ...rec, expiresAt: Date.now() + SELF_TTL_MS }).catch(() => {});
    }
    return { blobKey: rec.blobKey, atRestKey: rec.atRestKey, historyKey: rec.historyKey, mode: rec.mode };
  } catch (err) {
    logger.warn('[e2e][content-keys] load failed', { error: (err as Error)?.message });
    return null;
  }
}

/** Cheap freshness probe (no TTL slide). */
export async function hasFreshContentKeys(): Promise<boolean> {
  try {
    const rec = await readRecord();
    if (!rec) return false;
    if (rec.expiresAt !== null && Date.now() > rec.expiresAt) return false;
    return true;
  } catch {
    return false;
  }
}

/** Remove the persisted content keys (mode switch / forget-device / reset). */
export async function clearContentKeys(): Promise<void> {
  await deleteRecord().catch((err) => {
    logger.warn('[e2e][content-keys] clear failed', { error: (err as Error)?.message });
  });
}
