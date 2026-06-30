// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsGroupStore — the single IndexedDB funnel for MLS group state, ephemeral
 * KeyPackage private material, and per-profile meta. This is the seam the
 * SharedWorker single-writer owns.
 *
 * Persistence model:
 *  - `groups`    : per-DM-channel serialized ClientState, AES-256-GCM at rest.
 *  - `kpPrivate` : ephemeral KeyPackage private keys, AES-256-GCM at rest (the
 *                  public KeyPackage is stored alongside in cleartext, non-secret),
 *                  deleted after Welcome processing.
 *  - `identity` : per-device MLS identity (deviceId + signing keypair), keyed by
 *                  userId; signing private key AES-GCM at rest, public half cleartext.
 *  - `meta`     : reserved key/value scratch (no production writers today).
 *
 * The plaintext snapshot never touches disk. The at-rest key is derived (HKDF)
 * from dmKeyManager's unlock-derived key, set on unlock, dropped on lock. With
 * no key set, every group/kpPrivate read/write throws `mls store locked`.
 *
 * NOTE: we deliberately do NOT log key bytes or snapshots; the eviction warn
 * carries only counts.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { logger } from '../logger';
import { toBase64, fromBase64, toArrayBuffer } from '../cryptoHelpers';
import type { MlsClientState } from './types';
import type { KeyPackageCandidate } from './mlsEngine';
import { encodeState, decodeState } from './mlsEngine';
import type { MlsTier } from './roomKey';
import {
  verifyChainAndConnect, verifyChainWellFormed,
  type AikLink, type AikHead,
} from './aikRotation';

const DB_NAME = 'howl_mls';
const DB_VERSION = 7;
const STORE_GROUPS = 'groups';
const STORE_KP = 'kpPrivate';
const STORE_META = 'meta';
const STORE_HISTORY = 'history';
const STORE_IDENTITY = 'identity';
const STORE_DEVICEKEY = 'deviceKey';
const STORE_TRUST = 'trust';
const STORE_TOMBSTONE = 'tombstones'; // write-once deleted-message set

export const MAX_GROUPS = 5000; // defensive cap, oldest-eviction, logged when triggered

// Test seam (see __tests__/mlsGroupStore.test.ts). Production uses MAX_GROUPS.
let maxGroups = MAX_GROUPS;

// Bound the local readable-history archive. Oldest-eviction by
// updatedAt, PREFERRING already-uploaded rows (synced===1) so the cap never silently
// drops a synced===0 row that still owes an upload to the cross-device archive.
export const MAX_HISTORY = 50_000; // global per-account row cap, oldest-eviction
let maxHistory = MAX_HISTORY;

interface GroupRecord {
  dmChannelId: string; // PRIMARY KEY (keyPath) — holds the roomKey
  groupId: string;
  channelId?: string;  // bare dm channel id (additive; defaults to the key)
  tier?: MlsTier;      // additive; defaults to 'saved'
  encryptedSnapshot: ArrayBuffer;
  iv: ArrayBuffer;
  lastAppliedEpoch: string;
  updatedAt: number;
}
interface KpRecord {
  keyPackageRef: string;
  /** base64 of the PUBLIC KeyPackage wire bytes (non-secret, stored in cleartext). */
  keyPackage: string;
  encryptedPrivateKeyPackage: ArrayBuffer;
  iv: ArrayBuffer;
  isLastResort: boolean;
  createdAt: number;
  /** Cleartext at-rest-wrap discriminator. 1 = private bytes under the vault
   *  atRestKey (legacy); 2 = under the device wrap key. Absent on pre-v5 rows until
   *  the v5 upgrade stamps 1. NOT encrypted. */
  wrapVersion?: 1 | 2;
}
interface MetaRecord {
  key: string;
  value: string;
}

/**
 * Per-device MLS identity. Keyed by `userId` so two accounts sharing one browser
 * get distinct device identities. The public half + deviceId + credential are
 * non-secret cleartext (mirrors KpRecord's public KeyPackage); the Ed25519 signing
 * PRIVATE key is AES-GCM under atRestKey.
 */
interface IdentityRecord {
  userId: string;                              // keyPath
  deviceId: string;                            // cleartext (non-secret)
  signaturePublicKey: string;                  // base64 cleartext (non-secret)
  credentialIdentity: string;                  // base64 cleartext (= `${userId}:${deviceId}` bytes)
  encryptedSignaturePrivateKey: ArrayBuffer;   // AES-256-GCM under the device wrap key (v2) or the vault atRestKey (legacy v1); see wrapVersion
  iv: ArrayBuffer;
  createdAt: number;
  /** Cleartext at-rest-wrap discriminator. 1 = signing private key under the
   *  vault atRestKey (legacy); 2 = under the device wrap key. Absent on pre-v5 rows
   *  until the v5 upgrade stamps 1. NOT encrypted. */
  wrapVersion?: 1 | 2;
}

export interface StoredGroup {
  dmChannelId: string;
  groupId: string;
  lastAppliedEpoch: bigint;
}

/**
 * Per-user trust state. TOFU-pinned account identity key (AIK), plus the leaf keys
 * seen for each of that user's devices. The data is public (AIKs, leaf keys); it
 * rides the device-wrap key for tamper-resistance at rest, not confidentiality, and
 * to read pre-unlock (validateCredential runs at a Welcome that can arrive before
 * the first vault unlock).
 */
export interface TrustRecord {
  userId: string;
  pinnedAik: string;                 // base64 Ed25519 AIK public key (TOFU-pinned, advances only via an attested rotation chain)
  verified: boolean;                 // human-asserted (safety number). Dropped to false when the pin advances across a rotation.
  firstSeen: number;
  lastSeen: number;
  devices: { deviceId: string; leafKey: string; firstSeen: number }[];
  // Rotation-attestation continuity (all optional; absent on pre-rotation rows).
  aikHistory?: string[];             // AIKs we have walked through, oldest -> newest, ending at pinnedAik. Backward acceptance uses ONLY this.
  pinnedSeq?: number;                // anti-rollback floor: seq of the link that produced pinnedAik (0 for a genesis TOFU pin)
  rotatedAt?: number;                // when the pin last advanced across a rotation
}

// On-disk: keyPath userId cleartext; the rest of the record is wrapped under the
// device-wrap key (tamper-resistance at rest; available pre-unlock).
interface TrustRowOnDisk {
  userId: string;
  encrypted: ArrayBuffer;
  iv: ArrayBuffer;
}

// At-rest key (held only while unlocked)

let atRestKey: CryptoKey | null = null;

/** Set on unlock, cleared (null) on lock. */
export function setAtRestKey(key: CryptoKey | null): void {
  atRestKey = key;
}

/**
 * Read back the in-memory at-rest key, or null when the store is locked. Used by
 * dmKeyManager's auto-recovery: when a SIBLING tab's idle-lock tears down the
 * shared worker, this still-unlocked tab re-activates MLS under its own identity,
 * and the at-rest key it needs is exactly the one held here (per-tab module state;
 * a sibling's lock() nulls only ITS OWN copy, not ours). Returns null after a real
 * lock()/logout, so no decryption capability survives our own lock.
 */
export function getAtRestKey(): CryptoKey | null {
  return atRestKey;
}

function requireKey(): CryptoKey {
  if (!atRestKey) throw new Error('mls store locked');
  return atRestKey;
}

// History key (held only while unlocked; readable-history archive)

let historyKey: CryptoKey | null = null;

/** Set on unlock, cleared (null) on lock — mirrors setAtRestKey. */
export function setHistoryKey(key: CryptoKey | null): void {
  historyKey = key;
}

/** Read back the in-memory history key (for the sibling auto-recovery). */
export function getHistoryKey(): CryptoKey | null {
  return historyKey;
}

function requireHistoryKey(): CryptoKey {
  if (!historyKey) throw new Error('mls history store locked');
  return historyKey;
}

// AES-256-GCM at rest (fresh 12-byte IV per record)

/** Encrypt under an EXPLICIT key (fresh 12-byte IV). Lets re-key use old/new keys. */
async function encryptWithKey(key: CryptoKey, bytes: Uint8Array): Promise<{ ct: ArrayBuffer; iv: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toArrayBuffer(bytes));
  return { ct, iv: iv.buffer };
}

/** Decrypt under an EXPLICIT key. Lets re-key decrypt under the OLD key. */
async function decryptWithKey(key: CryptoKey, ct: ArrayBuffer, iv: ArrayBuffer): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ct);
  return new Uint8Array(pt);
}

async function encryptAtRest(plaintext: Uint8Array): Promise<{ ct: ArrayBuffer; iv: ArrayBuffer }> {
  return encryptWithKey(requireKey(), plaintext);
}

async function decryptAtRest(ct: ArrayBuffer, iv: ArrayBuffer): Promise<Uint8Array> {
  return decryptWithKey(requireKey(), ct, iv);
}

// -- Device-wrap at rest: identity + KP privates ride a persistent,
// non-extractable device key, NOT the vault at-rest key. Lets identity/KP ops
// succeed pre-unlock (atRestKey null) while group/history stay vault-keyed. --

async function encryptUnderDeviceWrap(bytes: Uint8Array): Promise<{ ct: ArrayBuffer; iv: ArrayBuffer }> {
  const key = await getOrCreateDeviceWrapKey();
  return encryptWithKey(key, bytes);
}

async function decryptUnderDeviceWrap(ct: ArrayBuffer, iv: ArrayBuffer): Promise<Uint8Array> {
  const key = await getOrCreateDeviceWrapKey();
  return decryptWithKey(key, ct, iv);
}

interface HistoryRecord {
  key: string;            // `${dmChannelId}:${envHash}` (keyed by the envelope hash)
  dmChannelId: string;
  messageId: string;      // indexed; carries the link for delete write-through
  envHash: string;        // hex SHA-256 of the source envelope
  iv: ArrayBuffer;
  encryptedPlaintext: ArrayBuffer; // AES-256-GCM(historyKey, utf8(plaintext))
  updatedAt: number;
  /** 0 = not yet uploaded to the server archive, 1 = uploaded.
   *  Numeric (not boolean) so it is a valid IndexedDB index key (a boolean key
   *  path is silently EXCLUDED from a plain index, leaving it permanently empty). */
  synced?: 0 | 1;
}

function historyRecordKey(dmChannelId: string, envHash: string): string {
  return `${dmChannelId}:${envHash}`;
}

/** A write-once record that `messageId` was deleted-for-everyone
 *  in `dmChannelId`. Consulted by the archive write/restore paths so a deleted
 *  message can never be resurrected (locally re-archived, or restored from a
 *  surviving server copy). Holds no message content — just the targeting ids. */
interface TombstoneRecord {
  key: string; // `${dmChannelId}:${messageId}`
  dmChannelId: string;
  messageId: string;
  createdAt: number;
}

function tombstoneKey(dmChannelId: string, messageId: string): string {
  return `${dmChannelId}:${messageId}`;
}

/** Record a write-once deleted-message tombstone. Idempotent: re-deleting keeps the
 *  original record (no clobber), and it is never removed except on full account
 *  reset (clearAll). Needs no historyKey — pure metadata, safe on any tab. */
export async function putTombstone(dmChannelId: string, messageId: string): Promise<void> {
  const key = tombstoneKey(dmChannelId, messageId);
  const db = await getDb();
  const tx = db.transaction(STORE_TOMBSTONE, 'readwrite');
  const store = tx.objectStore(STORE_TOMBSTONE);
  if ((await store.get(key)) === undefined) {
    const rec: TombstoneRecord = { key, dmChannelId, messageId, createdAt: Date.now() };
    await store.put(rec);
  }
  await tx.done;
}

/** True iff `messageId` was deleted-for-everyone in `dmChannelId`. */
export async function hasTombstone(dmChannelId: string, messageId: string): Promise<boolean> {
  const db = await getDb();
  return (await db.get(STORE_TOMBSTONE, tombstoneKey(dmChannelId, messageId))) !== undefined;
}

/**
 * Choose the history rows to evict when the store is at/over the cap and a
 * NEW row is about to be added. Returns [] when under cap. Oldest-first by updatedAt,
 * preferring synced===1 rows (safely on the server) before any synced===0 row that
 * still owes an upload. `overflow` is `count - maxHistory + 1` so the post-insert
 * count lands exactly at maxHistory. Pure (no IO) so it is trivially testable.
 */
function historyRowsToEvict(all: HistoryRecord[]): HistoryRecord[] {
  if (all.length < maxHistory) return [];
  const overflow = all.length - maxHistory + 1;
  const byAge = (a: HistoryRecord, b: HistoryRecord) => a.updatedAt - b.updatedAt;
  const synced = all.filter((r) => r.synced === 1).sort(byAge);
  const unsynced = all.filter((r) => r.synced !== 1).sort(byAge);
  return [...synced, ...unsynced].slice(0, overflow);
}

/** Enforce the history cap before adding a NEW row. Operates on the caller's
 *  in-tx history object store (structural type) so eviction is atomic with the write. */
async function evictHistoryForNewRow(historyStore: {
  getAll(): Promise<unknown[]>;
  delete(key: string): Promise<void>;
}): Promise<void> {
  const evict = historyRowsToEvict((await historyStore.getAll()) as HistoryRecord[]);
  if (evict.length === 0) return;
  for (const r of evict) await historyStore.delete(r.key);
  logger.warn('mlsGroupStore: evicted oldest history row(s) at cap', {
    evicted: evict.length,
    droppedUnsynced: evict.filter((r) => r.synced !== 1).length,
    cap: maxHistory,
  });
}

async function encryptHistory(plaintext: string): Promise<{ ct: ArrayBuffer; iv: ArrayBuffer }> {
  return encryptWithKey(requireHistoryKey(), new TextEncoder().encode(plaintext));
}

async function decryptHistory(ct: ArrayBuffer, iv: ArrayBuffer): Promise<string> {
  const pt = await decryptWithKey(requireHistoryKey(), ct, iv);
  return new TextDecoder().decode(pt);
}

// Hex SHA-256 of the source envelope, used to derive the history key suffix
// (history is keyed by `${channel}:${envHash}`). MUST stay byte-identical to
// mlsCoordinatorCore.sha256Hex: the receive path archives under the core's hash and
// the own-sent path (putHistory) archives under this one, so a reload getHistory hit
// requires both to produce the same digest for the same envelope bytes. The store is
// a leaf dependency of the core (the core imports the store, not vice versa), so this
// is a deliberate copy, not an import; __tests__ pin the equivalence.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// DB handle (re-opened per call set so a fresh test IDBFactory is honored)

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains(STORE_GROUPS)) {
          db.createObjectStore(STORE_GROUPS, { keyPath: 'dmChannelId' });
        }
        if (!db.objectStoreNames.contains(STORE_KP)) {
          db.createObjectStore(STORE_KP, { keyPath: 'keyPackageRef' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_HISTORY)) {
          // Keyed by `${dmChannelId}:${envHash}`: a row is the durable memo
          // of decrypt(envelope). dmChannelId index = per-channel enumeration;
          // messageId index = delete write-through (remove all revisions).
          const h = db.createObjectStore(STORE_HISTORY, { keyPath: 'key' });
          h.createIndex('dmChannelId', 'dmChannelId');
          h.createIndex('messageId', 'messageId');
          h.createIndex('synced', 'synced'); // enumerate unsynced via IDBKeyRange.only(0)
        }
        if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
          // Per-device MLS identity, one row per userId. See IdentityRecord.
          db.createObjectStore(STORE_IDENTITY, { keyPath: 'userId' });
        }
        // v4: add the synced index to a PRE-EXISTING history store and
        // stamp every old row synced=0 (a plain index EXCLUDES a row whose key path
        // is absent, so unstamped legacy rows would never appear in the index). The
        // stamping cursor runs inside the versionchange `tx` (valid in idb upgrade).
        if (oldVersion > 0 && oldVersion < 4 && db.objectStoreNames.contains(STORE_HISTORY)) {
          const h = tx.objectStore(STORE_HISTORY);
          if (!h.indexNames.contains('synced')) h.createIndex('synced', 'synced');
          void h.openCursor().then(function stamp(cursor): unknown {
            if (!cursor) return undefined;
            const rec = cursor.value as HistoryRecord;
            if (rec.synced === undefined) void cursor.update({ ...rec, synced: 0 });
            return cursor.continue().then(stamp);
          });
        }
        // v5: a new dedicated CryptoKey store for the always-on device wrap
        // key, plus stamp every PRE-EXISTING identity/kp row cleartext
        // wrapVersion:1. A legacy row has its private bytes wrapped under the
        // vault atRestKey; the discriminator lets the read path branch v1 (vault)
        // vs v2 (device) without a decrypt probe. Unstamped rows would be ambiguous
        // (getIdentityMeta cannot tell "legacy" from "new"), so stamp them now.
        if (oldVersion > 0 && oldVersion < 5) {
          if (!db.objectStoreNames.contains(STORE_DEVICEKEY)) {
            db.createObjectStore(STORE_DEVICEKEY, { keyPath: 'id' });
          }
          if (db.objectStoreNames.contains(STORE_IDENTITY)) {
            const ids = tx.objectStore(STORE_IDENTITY);
            void ids.openCursor().then(function stamp(cursor): unknown {
              if (!cursor) return undefined;
              const rec = cursor.value as { wrapVersion?: number };
              if (rec.wrapVersion === undefined) void cursor.update({ ...rec, wrapVersion: 1 });
              return cursor.continue().then(stamp);
            });
          }
          if (db.objectStoreNames.contains(STORE_KP)) {
            const kps = tx.objectStore(STORE_KP);
            void kps.openCursor().then(function stamp(cursor): unknown {
              if (!cursor) return undefined;
              const rec = cursor.value as { wrapVersion?: number };
              if (rec.wrapVersion === undefined) void cursor.update({ ...rec, wrapVersion: 1 });
              return cursor.continue().then(stamp);
            });
          }
        }
        // A FRESH install (oldVersion === 0) gets the store from a dedicated
        // createObjectStore guard so first-run devices also have it.
        if (!db.objectStoreNames.contains(STORE_DEVICEKEY)) {
          db.createObjectStore(STORE_DEVICEKEY, { keyPath: 'id' });
        }
        // v6: TOFU-pinned AIK per user. Unconditional guard so
        // it runs for fresh installs AND upgrades (do NOT gate behind oldVersion).
        if (!db.objectStoreNames.contains(STORE_TRUST)) {
          db.createObjectStore(STORE_TRUST, { keyPath: 'userId' });
        }
        // v7: write-once deleted-message tombstones, keyed by
        // `${dmChannelId}:${messageId}` (delete-for-everyone targets all envelope
        // revisions of a messageId). Carries NO plaintext/ciphertext (just ids), so
        // it needs no historyKey and survives rekey. Unconditional guard (fresh +
        // upgrade); no data migration needed.
        if (!db.objectStoreNames.contains(STORE_TOMBSTONE)) {
          const ts = db.createObjectStore(STORE_TOMBSTONE, { keyPath: 'key' });
          ts.createIndex('dmChannelId', 'dmChannelId');
        }
      },
      blocking() {
        // A reloaded tab is trying to upgrade while we hold the DB open. Close our
        // connection AND null the cached promise so the next getDb() transparently
        // reopens at the new version (closing alone leaves a dead cached handle that
        // throws InvalidStateError on the next worker tx and breaks MLS origin-wide).
        // ALREADY-OPEN transactions complete before close() takes effect, so no
        // in-flight write is torn (no data corruption). Caveat: a store op that
        // captured this db handle and then STARTS a NEW transaction after the deferred
        // close lands throws InvalidStateError — a rare, deploy-window-only transient
        // (a failed send / momentary lock placeholder) that self-heals on retry/reload
        // since the persisted ratchet was never advanced. A defensive InvalidStateError
        // single-retry on the store ops is a tracked follow-up.
        void Promise.resolve(dbPromise).then((db) => { try { db?.close(); } catch { /* already closed */ } });
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

// Groups

export async function putGroup(
  dmChannelId: string,            // roomKey
  groupId: string,
  state: MlsClientState,
  lastAppliedEpoch: bigint,
  opts?: { channelId?: string; tier?: MlsTier },
): Promise<void> {
  const snapshot = encodeState(state); // sync; at-rest key checked below
  const { ct, iv } = await encryptAtRest(snapshot);
  const db = await getDb();

  // Defensive oldest-eviction when at/over cap (and this is a new channel).
  const existing = await db.get(STORE_GROUPS, dmChannelId);
  if (!existing) {
    const count = await db.count(STORE_GROUPS);
    if (count >= maxGroups) {
      const all = (await db.getAll(STORE_GROUPS)) as GroupRecord[];
      all.sort((a, b) => a.updatedAt - b.updatedAt);
      const toEvict = all.slice(0, count - maxGroups + 1);
      const tx = db.transaction(STORE_GROUPS, 'readwrite');
      for (const rec of toEvict) await tx.store.delete(rec.dmChannelId);
      await tx.done;
      logger.warn('mlsGroupStore: evicted oldest group(s) at cap', { evicted: toEvict.length, cap: maxGroups });
    }
  }

  const record: GroupRecord = {
    dmChannelId,
    groupId,
    channelId: opts?.channelId ?? dmChannelId,
    tier: opts?.tier ?? 'saved',
    encryptedSnapshot: ct,
    iv,
    lastAppliedEpoch: lastAppliedEpoch.toString(),
    updatedAt: Date.now(),
  };
  await db.put(STORE_GROUPS, record);
}

export async function getGroup(
  dmChannelId: string,
): Promise<{ state: MlsClientState; meta: StoredGroup } | null> {
  requireKey(); // fail closed before any IDB read
  const db = await getDb();
  const rec = (await db.get(STORE_GROUPS, dmChannelId)) as GroupRecord | undefined;
  if (!rec) return null;
  const snapshot = await decryptAtRest(rec.encryptedSnapshot, rec.iv);
  const state = decodeState(snapshot, rec.tier ?? 'saved');
  return {
    state,
    meta: {
      dmChannelId: rec.dmChannelId,
      groupId: rec.groupId,
      lastAppliedEpoch: BigInt(rec.lastAppliedEpoch),
    },
  };
}

/**
 * Archive read for the readable-history layer. Keyed by (dmChannelId, envHash):
 * a row can only ever be the plaintext of that exact envelope, so a hit is correct
 * by construction — an edited message is simply a different envelope/key.
 * Returns null on miss or when the history key is locked, so the caller falls back
 * to live decrypt and never throws on the read path.
 */
export async function getHistory(dmChannelId: string, envHash: string): Promise<string | null> {
  if (!historyKey) return null;
  const db = await getDb();
  const rec = (await db.get(STORE_HISTORY, historyRecordKey(dmChannelId, envHash))) as HistoryRecord | undefined;
  if (!rec) return null;
  try {
    return await decryptHistory(rec.encryptedPlaintext, rec.iv);
  } catch {
    return null; // unreadable record — fall back to live decrypt
  }
}

/**
 * Persist an advanced-ratchet group snapshot AND the just-decrypted plaintext in
 * ONE IndexedDB transaction spanning groups + history (atomicity): the
 * single-use ratchet must never advance durably without the plaintext being
 * captured, or the message would be permanently undecryptable after reload. Both
 * records are encrypted BEFORE the transaction opens (idb auto-commits a readwrite
 * tx once the microtask queue drains with no pending request). The group store has
 * no per-channel eviction (a decrypt always targets an existing group); the history
 * store is bounded by MAX_HISTORY oldest-eviction on each NEW row, run in
 * THIS tx so the cap stays atomic with the ratchet+plaintext write.
 */
export async function putGroupAndHistory(
  dmChannelId: string,
  groupId: string,
  state: MlsClientState,
  lastAppliedEpoch: bigint,
  history: { messageId: string; plaintext: string; envHash: string },
): Promise<void> {
  const snapshot = encodeState(state);
  const group = await encryptAtRest(snapshot);
  const hist = await encryptHistory(history.plaintext);
  const groupRecord: GroupRecord = {
    dmChannelId,
    groupId,
    channelId: dmChannelId,
    tier: 'saved',
    encryptedSnapshot: group.ct,
    iv: group.iv,
    lastAppliedEpoch: lastAppliedEpoch.toString(),
    updatedAt: Date.now(),
  };
  const historyRecord: HistoryRecord = {
    key: historyRecordKey(dmChannelId, history.envHash),
    dmChannelId,
    messageId: history.messageId,
    envHash: history.envHash,
    iv: hist.iv,
    encryptedPlaintext: hist.ct,
    updatedAt: Date.now(),
  };
  const db = await getDb();
  const tx = db.transaction([STORE_GROUPS, STORE_HISTORY, STORE_TOMBSTONE], 'readwrite');
  // A delete-for-everyone tombstone suppresses the plaintext archive, but
  // the advanced ratchet snapshot MUST still persist (losing it makes the message
  // permanently undecryptable — the atomicity invariant).
  const tombstoned =
    (await tx.objectStore(STORE_TOMBSTONE).get(tombstoneKey(dmChannelId, history.messageId))) !== undefined;
  // Read the existing history row INSIDE this tx so a same-envelope overwrite
  // preserves its synced flag (a new envelope = a new row = unsynced). A separate
  // read tx would race a concurrent markHistorySynced.
  const existingHist = (await tx.objectStore(STORE_HISTORY).get(historyRecord.key)) as HistoryRecord | undefined;
  await tx.objectStore(STORE_GROUPS).put(groupRecord);
  if (!tombstoned) {
    if (!existingHist) await evictHistoryForNewRow(tx.objectStore(STORE_HISTORY)); // cap (new row only)
    await tx.objectStore(STORE_HISTORY).put({ ...historyRecord, synced: existingHist?.synced ?? 0 });
  }
  await tx.done;
}

/**
 * History-ONLY write for own-sent (and own-edited) plaintext. The
 * sender cannot self-decrypt its own MLS ciphertext (ts-mls seals an application
 * message to the OTHER members' ratchets and advances only the sender ratchet), so
 * the receive-path archive in core.decrypt never captures own-sent messages and the
 * sender's own history would render as the lock placeholder after reload. The send
 * path calls this with the plaintext it already holds, keyed by the SAME envelope
 * hash the read path computes, so reload getHistory hits and deleteHistory
 * ("delete for everyone", keyed by messageId) both work identically to received rows.
 *
 * Touches STORE_HISTORY ONLY — never STORE_GROUPS — so a MAIN-THREAD call can never
 * clobber the worker-owned sender-ratchet snapshot (the critical single-writer
 * invariant; this is the sender-side analogue of putGroupAndHistory minus the group
 * record). IndexedDB is origin-global, so the main thread writes and the worker reads
 * under the same historyKey. Lets encryptHistory throw 'mls history store locked' when
 * no historyKey is installed (locked / Self-recovery), so the caller's best-effort
 * try/catch no-ops — mirroring the receive path's getHistoryKey() !== null archive
 * guard. messageId is required (the row must be delete-targetable) and is always
 * available at send time (the server-assigned id).
 */
export async function putHistory(
  dmChannelId: string,
  history: { messageId: string; plaintext: string; envelopeContent: string },
): Promise<void> {
  const envHash = await sha256Hex(history.envelopeContent);
  const hist = await encryptHistory(history.plaintext); // encrypt BEFORE the tx (throws if locked)
  const key = historyRecordKey(dmChannelId, envHash);
  const db = await getDb();
  const tx = db.transaction([STORE_HISTORY, STORE_TOMBSTONE], 'readwrite');
  // Never re-archive a message that was deleted-for-everyone (closes the
  // send/edit re-archive race — a late putHistory after a delete must not re-seed it).
  if ((await tx.objectStore(STORE_TOMBSTONE).get(tombstoneKey(dmChannelId, history.messageId))) !== undefined) {
    await tx.done;
    return;
  }
  const store = tx.objectStore(STORE_HISTORY);
  // Read the existing row INSIDE this tx so a same-envelope overwrite preserves
  // synced (a new row = unsynced). A separate read tx would race markHistorySynced.
  const existing = (await store.get(key)) as HistoryRecord | undefined;
  const historyRecord: HistoryRecord = {
    key,
    dmChannelId,
    messageId: history.messageId,
    envHash,
    iv: hist.iv,
    encryptedPlaintext: hist.ct,
    updatedAt: Date.now(),
    synced: existing?.synced ?? 0,
  };
  if (!existing) await evictHistoryForNewRow(store); // cap (new row only)
  await store.put(historyRecord);
  await tx.done;
}

/**
 * Decrypt + return unsynced history rows for upload (bounded). Returns
 * [] when locked. Skips rows that fail to decrypt (key gone mid-enumerate) — they
 * stay unsynced and retry on the next trigger. `msgCreatedAt` = the local archive
 * time (the row's updatedAt). Enumerates via the numeric `synced` index using
 * IDBKeyRange.only(0) (boolean keys would never index, hence the numeric flag).
 */
export async function listUnsyncedHistory(
  limit: number,
): Promise<Array<{ key: string; dmChannelId: string; messageId: string; envHash: string; plaintext: string; msgCreatedAt: number }>> {
  if (!historyKey) return [];
  const db = await getDb();
  const recs = (await db.getAllFromIndex(STORE_HISTORY, 'synced', IDBKeyRange.only(0), limit)) as HistoryRecord[];
  const out: Array<{ key: string; dmChannelId: string; messageId: string; envHash: string; plaintext: string; msgCreatedAt: number }> = [];
  for (const rec of recs) {
    try {
      const plaintext = await decryptHistory(rec.encryptedPlaintext, rec.iv);
      out.push({
        key: rec.key,
        dmChannelId: rec.dmChannelId,
        messageId: rec.messageId,
        envHash: rec.envHash,
        plaintext,
        msgCreatedAt: rec.updatedAt,
      });
    } catch {
      // unreadable (locked / mid-rekey) — skip; never silently "nothing to send".
    }
  }
  return out;
}

/**
 * Flip rows to synced=1 after a successful upload, in a single tx that
 * RE-READS each row so a concurrent delete-for-everyone is never resurrected (a key
 * deleted mid-flight is simply skipped — we never put() a row that no longer exists).
 */
export async function markHistorySynced(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await getDb();
  const tx = db.transaction(STORE_HISTORY, 'readwrite');
  const store = tx.objectStore(STORE_HISTORY);
  for (const key of keys) {
    const rec = (await store.get(key)) as HistoryRecord | undefined;
    if (rec && rec.synced !== 1) await store.put({ ...rec, synced: 1 });
  }
  await tx.done;
}

/**
 * Move-to-Private - flip history rows back to synced=0 so the upload syncer
 * re-seals + re-uploads them under the rotated archiveKey. Cleartext flag only (no
 * historyKey needed), so it is safe regardless of historyKey state. Cursor-walks the
 * whole store in one readwrite tx, skipping rows already at 0.
 *
 * `activeChannelIds`: when provided, re-arm ONLY rows for those channels. The
 * move-to-Private re-seal must skip channels the user has left (group DMs they were
 * removed from): the server 403s a non-participant archive write, and an all-or-nothing
 * POST batch would wedge the entire re-upload. Omit the arg (undefined) to re-arm every
 * row (the original behaviour). An empty array re-arms nothing.
 */
export async function markAllHistoryUnsynced(activeChannelIds?: string[]): Promise<void> {
  const allow = activeChannelIds ? new Set(activeChannelIds) : null;
  const db = await getDb();
  const tx = db.transaction(STORE_HISTORY, 'readwrite');
  const store = tx.objectStore(STORE_HISTORY);
  let cursor = await store.openCursor();
  while (cursor) {
    const rec = cursor.value as HistoryRecord;
    if (rec.synced !== 0 && (!allow || allow.has(rec.dmChannelId))) {
      await cursor.update({ ...rec, synced: 0 });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Write a server-restored row keyed by a supplied envHash, synced=1,
 * ONLY if absent (never clobber a local row — restore fills gaps, e.g. messages
 * sent before this device joined). Requires historyKey (present whenever unlocked);
 * encryptHistory throws 'mls history store locked' when no key is set, so the
 * caller's best-effort try/catch no-ops, mirroring the receive-path archive guard.
 */
export async function putHistoryRestored(
  dmChannelId: string,
  rec: { messageId: string; plaintext: string; envHash: string },
): Promise<void> {
  const hist = await encryptHistory(rec.plaintext); // throws if locked — caller best-efforts
  const key = historyRecordKey(dmChannelId, rec.envHash);
  const db = await getDb();
  const tx = db.transaction([STORE_HISTORY, STORE_TOMBSTONE], 'readwrite');
  // Never restore a message that was deleted-for-everyone on this device.
  if ((await tx.objectStore(STORE_TOMBSTONE).get(tombstoneKey(dmChannelId, rec.messageId))) !== undefined) {
    await tx.done;
    return;
  }
  const store = tx.objectStore(STORE_HISTORY);
  const existing = await store.get(key);
  if (!existing) {
    await evictHistoryForNewRow(store); // cap (new row only)
    const historyRecord: HistoryRecord = {
      key,
      dmChannelId,
      messageId: rec.messageId,
      envHash: rec.envHash,
      iv: hist.iv,
      encryptedPlaintext: hist.ct,
      updatedAt: Date.now(),
      synced: 1,
    };
    await store.put(historyRecord);
  }
  await tx.done;
}

/**
 * Delete write-through: remove EVERY history row for a messageId (the original
 * plus any retained edit revisions, which live under different envelope hashes but
 * share the messageId). Honors a remote "delete for everyone" by dropping the local
 * plaintext. Needs no historyKey (pure row deletion) and is idempotent, so it is
 * safe to run unconditionally on any tab. IndexedDB is origin-global, so this works
 * from the main thread even when the worker owns decryption.
 */
export async function deleteHistory(dmChannelId: string, messageId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_HISTORY, STORE_TOMBSTONE], 'readwrite');
  // Record the write-once tombstone FIRST and UNCONDITIONALLY (even when no
  // local row exists, e.g. a delete-for-everyone for a message this device never
  // received) so a later restore from a surviving server copy is suppressed.
  const tk = tombstoneKey(dmChannelId, messageId);
  if ((await tx.objectStore(STORE_TOMBSTONE).get(tk)) === undefined) {
    const ts: TombstoneRecord = { key: tk, dmChannelId, messageId, createdAt: Date.now() };
    await tx.objectStore(STORE_TOMBSTONE).put(ts);
  }
  // Read the messageId key-set INSIDE this readwrite tx (IDB serializes same-store
  // readwrite txs), NOT via a separate one-shot getAllKeysFromIndex tx — otherwise a
  // concurrent same-messageId archive write (an in-flight edit revision / restore /
  // receive-path) committed after the snapshot would leave an undeleted row. Here the
  // concurrent write either lands before this tx (and is in the key-set we delete) or
  // after it (and sees the tombstone and skips).
  const keys = (await tx.objectStore(STORE_HISTORY).index('messageId').getAllKeys(messageId)) as string[];
  for (const k of keys) await tx.objectStore(STORE_HISTORY).delete(k);
  await tx.done;
}

export async function listGroupChannelIds(): Promise<string[]> {
  const db = await getDb();
  return (await db.getAllKeys(STORE_GROUPS)) as string[];
}

export type GroupChannelEntry = { roomKey: string; channelId: string; tier: MlsTier };

export async function getGroupIdToChannelMap(): Promise<Map<string, GroupChannelEntry>> {
  const db = await getDb();
  const all = (await db.getAll(STORE_GROUPS)) as GroupRecord[];
  const map = new Map<string, GroupChannelEntry>();
  for (const rec of all) {
    map.set(rec.groupId, {
      roomKey: rec.dmChannelId,
      channelId: rec.channelId ?? rec.dmChannelId,
      tier: rec.tier ?? 'saved',
    });
  }
  return map;
}

export async function deleteGroup(dmChannelId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_GROUPS, dmChannelId);
}

// KeyPackage private material

export async function putKpPrivate(
  keyPackageRef: string,
  keyPackage: Uint8Array,
  privateKeyPackage: Uint8Array,
  isLastResort: boolean,
): Promise<void> {
  const { ct, iv } = await encryptUnderDeviceWrap(privateKeyPackage);
  const db = await getDb();
  const record: KpRecord = {
    keyPackageRef,
    keyPackage: toBase64(keyPackage),
    encryptedPrivateKeyPackage: ct,
    iv,
    isLastResort,
    createdAt: Date.now(),
    wrapVersion: 2,
  };
  await db.put(STORE_KP, record);
}

// Decrypt a KP private under the right key for its wrapVersion. v2 -> device wrap
// (reads pre-unlock). v1 -> vault at-rest read-compat; opportunistically re-wrap to
// v2 when the vault is unlocked, so KP privates stop depending on the vault password.
async function decryptKpRecord(rec: KpRecord): Promise<Uint8Array> {
  if (rec.wrapVersion === 2) return decryptUnderDeviceWrap(rec.encryptedPrivateKeyPackage, rec.iv);
  if (!atRestKey) throw new Error('mls store locked'); // legacy v1 needs the vault key
  const priv = await decryptAtRest(rec.encryptedPrivateKeyPackage, rec.iv);
  try {
    const { ct, iv } = await encryptUnderDeviceWrap(priv);
    const db = await getDb();
    await db.put(STORE_KP, { ...rec, encryptedPrivateKeyPackage: ct, iv, wrapVersion: 2 });
  } catch (err) {
    logger.warn('mlsGroupStore: kpPrivate v1->v2 re-wrap failed; left as v1', { error: (err as Error)?.name });
  }
  return priv;
}

export async function getAllKeyPackageCandidates(): Promise<KeyPackageCandidate[]> {
  const db = await getDb();
  const all = (await db.getAll(STORE_KP)) as KpRecord[];
  const out: KeyPackageCandidate[] = [];
  for (const rec of all) {
    out.push({
      keyPackageRef: rec.keyPackageRef,
      keyPackage: fromBase64(rec.keyPackage),
      privateKeyPackage: await decryptKpRecord(rec),
      isLastResort: rec.isLastResort,
    });
  }
  return out;
}

export async function deleteKpPrivate(keyPackageRef: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_KP, keyPackageRef);
}

/**
 * Delete this device's MLS identity row. Called by recover()/serverRecover()
 * BEFORE load-or-mint to FORCE a fresh identity: under the persistent device wrap the
 * old recovery-driven at-rest-key rotation no longer makes the identity undecryptable,
 * so revocation must be explicit. Idempotent (no-op when absent).
 */
export async function deleteIdentity(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_IDENTITY, userId);
}

/**
 * Wipe every KeyPackage private. Paired with deleteIdentity on recovery so
 * the freshly-minted identity does not coexist with KP privates bound to the revoked
 * signing key. Idempotent.
 */
export async function deleteAllKpPrivate(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE_KP);
}

// Meta (non-secret, plaintext)

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const rec = (await db.get(STORE_META, key)) as MetaRecord | undefined;
  return rec ? rec.value : null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  const record: MetaRecord = { key, value };
  await db.put(STORE_META, record);
}

// Per-device MLS identity

/**
 * Persist this device's MLS identity for `userId`. Public half + deviceId +
 * credential are cleartext; the signing private key is encrypted under the
 * persistent device wrap key, so the write succeeds even before vault
 * unlock.
 */
export async function putIdentity(
  userId: string,
  deviceId: string,
  signaturePublicKey: Uint8Array,
  signaturePrivateKey: Uint8Array,
  credentialIdentity: Uint8Array,
): Promise<void> {
  const { ct, iv } = await encryptUnderDeviceWrap(signaturePrivateKey);
  const db = await getDb();
  const record: IdentityRecord = {
    userId,
    deviceId,
    signaturePublicKey: toBase64(signaturePublicKey),
    credentialIdentity: toBase64(credentialIdentity),
    encryptedSignaturePrivateKey: ct,
    iv,
    createdAt: Date.now(),
    wrapVersion: 2,
  };
  await db.put(STORE_IDENTITY, record);
}

/**
 * Read this device's MLS identity for `userId`. v2 rows (device-wrap) read
 * pre-unlock; legacy v1 rows read only while the vault is unlocked and are
 * opportunistically re-wrapped to v2. Returns null when absent or undecryptable
 * under the available keys.
 */
export async function getIdentity(userId: string): Promise<{
  userId: string;
  deviceId: string;
  signaturePublicKey: Uint8Array;
  signaturePrivateKey: Uint8Array;
  credentialIdentity: Uint8Array;
} | null> {
  const db = await getDb();
  const rec = (await db.get(STORE_IDENTITY, userId)) as IdentityRecord | undefined;
  if (!rec) return null;
  try {
    let signaturePrivateKey: Uint8Array;
    if (rec.wrapVersion === 2) {
      // Go-forward: device-wrap. Reads pre-unlock (atRestKey may be null).
      signaturePrivateKey = await decryptUnderDeviceWrap(rec.encryptedSignaturePrivateKey, rec.iv);
    } else {
      // Legacy v1: signing private was AES-GCM under the vault at-rest key. Only
      // readable while the vault is unlocked; pre-unlock we cannot decrypt -> null
      // (but getIdentityMeta still reports the row exists, so the provisioner
      // DEFERS rather than minting a colliding 2nd identity).
      if (!atRestKey) return null;
      signaturePrivateKey = await decryptAtRest(rec.encryptedSignaturePrivateKey, rec.iv);
      // Opportunistic re-wrap v1 -> v2 so subsequent (pre-unlock) reads succeed and
      // the identity stops depending on the vault password.
      try {
        const { ct, iv } = await encryptUnderDeviceWrap(signaturePrivateKey);
        await db.put(STORE_IDENTITY, { ...rec, encryptedSignaturePrivateKey: ct, iv, wrapVersion: 2 });
      } catch (err) {
        logger.warn('mlsGroupStore: identity v1->v2 re-wrap failed; left as v1', { error: (err as Error)?.name });
      }
    }
    return {
      userId: rec.userId,
      deviceId: rec.deviceId,
      signaturePublicKey: fromBase64(rec.signaturePublicKey),
      signaturePrivateKey,
      credentialIdentity: fromBase64(rec.credentialIdentity),
    };
  } catch {
    return null; // unreadable under the available keys - treat as a fresh device
  }
}

/**
 * Key-free pre-unlock probe of this device's identity row. Reads the
 * STORE_IDENTITY row WITHOUT requireKey()/decrypt and returns its cleartext
 * wrapVersion discriminator (defaulting an absent field to 1 = legacy). Returns
 * null when no row exists.
 *
 * getIdentity() returns null for BOTH "no row" and "undecryptable row", so a
 * LEGACY (v1-wrapped) device - whose row IS present but is wrapped under the vault
 * key the boot provisioner doesn't have yet - would look identical to a fresh
 * device and mint a SECOND identity = a leaf-identity collision. This probe lets the
 * boot provisioner branch instead: null -> mint; v1 -> DEFER to the next unlock
 * (which re-wraps to v2); v2 -> load + top-up.
 */
export async function getIdentityMeta(
  userId: string,
): Promise<{ exists: boolean; wrapVersion: 1 | 2 } | null> {
  const db = await getDb();
  const rec = (await db.get(STORE_IDENTITY, userId)) as IdentityRecord | undefined;
  if (!rec) return null;
  // An absent discriminator means a pre-v5 (or mid-upgrade) row; treat it as
  // legacy v1 so a legacy device never mints a duplicate identity.
  return { exists: true, wrapVersion: rec.wrapVersion ?? 1 };
}

// Per-user trust store

async function readTrustRow(userId: string): Promise<TrustRecord | null> {
  const db = await getDb();
  const row = (await db.get(STORE_TRUST, userId)) as TrustRowOnDisk | undefined;
  if (!row) return null;
  try {
    const pt = await decryptUnderDeviceWrap(row.encrypted, row.iv);
    return JSON.parse(new TextDecoder().decode(pt)) as TrustRecord;
  } catch {
    return null; // tampered / undecryptable row: treat as absent (caller fails closed)
  }
}

async function writeTrustRow(rec: TrustRecord): Promise<void> {
  const { ct, iv } = await encryptUnderDeviceWrap(new TextEncoder().encode(JSON.stringify(rec)));
  const db = await getDb();
  await db.put(STORE_TRUST, { userId: rec.userId, encrypted: ct, iv } satisfies TrustRowOnDisk);
}

export async function getTrustRecord(userId: string): Promise<TrustRecord | null> {
  return readTrustRow(userId);
}

// --- Rotation-attestation wiring (injected; the store has no API/layer dependency) ---

export type RotationChainFetcher = (
  userId: string,
) => Promise<{ chain: AikLink[]; head: AikHead | null } | null>;

let _rotationChainFetcher: RotationChainFetcher | null = null;
/** Inject the (network) rotation-chain fetcher. Absent ⇒ pinOrVerifyAik fails closed on mismatch. */
export function setRotationChainFetcher(fn: RotationChainFetcher | null): void {
  _rotationChainFetcher = fn;
}

interface CachedChain { chain: AikLink[]; head: AikHead | null; fetchedAt: number }
const _chainCache = new Map<string, CachedChain>();
const CHAIN_CACHE_TTL_MS = 60_000;

/**
 * Cached-verified-or-fetch the rotation chain for a user. Structural well-formedness
 * is checked once here (a malformed served chain is cached as empty so we fail closed
 * without hammering the network); signatures are verified later, rooted at our pin, in
 * verifyChainAndConnect. Returns the cache when offline; null when offline + uncached
 * (the caller then fails closed — a transient state §D.3 retries after a prefetch).
 */
async function getRotationChain(
  userId: string,
): Promise<{ chain: AikLink[]; head: AikHead | null } | null> {
  const now = Date.now();
  const cached = _chainCache.get(userId);
  if (cached && now - cached.fetchedAt < CHAIN_CACHE_TTL_MS) {
    return { chain: cached.chain, head: cached.head };
  }
  if (!_rotationChainFetcher) return cached ? { chain: cached.chain, head: cached.head } : null;
  try {
    const fetched = await _rotationChainFetcher(userId);
    if (!fetched) return cached ? { chain: cached.chain, head: cached.head } : null;
    const wellFormed = verifyChainWellFormed(fetched.chain);
    const value: CachedChain = wellFormed
      ? { chain: fetched.chain, head: fetched.head ?? null, fetchedAt: now }
      : { chain: [], head: null, fetchedAt: now };
    _chainCache.set(userId, value);
    return { chain: value.chain, head: value.head };
  } catch {
    return cached ? { chain: cached.chain, head: cached.head } : null;
  }
}

// Per-user serialization for the trust read-modify-write. The mismatch path awaits a
// network fetch between read and write, widening the TOCTOU window; the lock + a
// compare-and-set on pinnedAik make the pin advance atomic per user (A10).
const _trustLocks = new Map<string, Promise<unknown>>();
function withTrustLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _trustLocks.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const guard = run.catch(() => undefined);
  _trustLocks.set(userId, guard);
  void guard.finally(() => { if (_trustLocks.get(userId) === guard) _trustLocks.delete(userId); });
  return run;
}

function addDevice(
  rec: TrustRecord,
  device: { deviceId: string; leafKey: Uint8Array } | undefined,
  now: number,
): void {
  if (device && !rec.devices.some((d) => d.deviceId === device.deviceId)) {
    rec.devices.push({ deviceId: device.deviceId, leafKey: toBase64(device.leafKey), firstSeen: now });
  }
}

/**
 * TOFU-pin a user's AIK, or verify a presented AIK against the existing pin.
 *
 * Returns true when the AIK is accepted: first-sight pin, an exact match, an attested
 * forward rotation that advances the pin, or a lagging-but-genuine older leaf already in
 * our local history. Returns false (fail closed, never overwriting the pin) on an
 * unattested, unrooted, non-linear, broken, or rolled-back mismatch — or when the chain
 * is unavailable (offline + uncached), which a later validation retries.
 *
 * This treats the account's OWN userId exactly like any peer: our own current AIK matches
 * the pin, our rotated AIK advances via our own signed chain, our old AIK is accepted as
 * lagging via local history, and an AIK we never held is rejected. (An earlier blanket
 * self short-circuit was REMOVED — it trusted any AIK presented under the self-asserted
 * userId, letting the server external-commit an attacker leaf claiming our userId and read
 * our outbound traffic. The chain path is both correct and secure for self.)
 */
export async function pinOrVerifyAik(
  userId: string,
  aikPub: Uint8Array,
  device?: { deviceId: string; leafKey: Uint8Array },
): Promise<boolean> {
  const aikB64 = toBase64(aikPub);
  return withTrustLock(userId, async () => {
    const now = Date.now();
    const existing = await readTrustRow(userId);
    if (!existing) {
      const rec: TrustRecord = {
        userId,
        pinnedAik: aikB64,
        verified: false,
        firstSeen: now,
        lastSeen: now,
        devices: device ? [{ deviceId: device.deviceId, leafKey: toBase64(device.leafKey), firstSeen: now }] : [],
        aikHistory: [aikB64],
        pinnedSeq: 0,
      };
      await writeTrustRow(rec);
      return true;
    }
    if (existing.pinnedAik === aikB64) {
      existing.lastSeen = now;
      addDevice(existing, device, now);
      await writeTrustRow(existing);
      return true;
    }

    // Mismatch: the ONLY legitimate way to move (or accept around) the pin is an
    // attested rotation chain rooted at our own pin. Everything else fails closed.
    // Any unexpected error in the (server-fed) chain path is treated as a rejection
    // (fail closed), never a thrown rejection that could surface as something else.
    let verdict: ReturnType<typeof verifyChainAndConnect>;
    try {
      const fetched = await getRotationChain(userId);
      if (!fetched) return false; // offline + uncached: transient fail-closed (retried later)
      verdict = verifyChainAndConnect({
        userId,
        candidate: aikB64,
        ctx: {
          pinnedAik: existing.pinnedAik,
          pinnedSeq: existing.pinnedSeq ?? 0,
          aikHistory: existing.aikHistory ?? [existing.pinnedAik],
        },
        chain: fetched.chain,
        head: fetched.head,
      });
    } catch {
      return false;
    }
    if (verdict.kind === 'reject') return false;
    if (verdict.kind === 'lagging') {
      // Older-but-genuine leaf (forward of our pin, but this device hasn't caught up).
      // Accept it; do NOT move the pin. Record the device under the unchanged pin.
      existing.lastSeen = now;
      addDevice(existing, device, now);
      await writeTrustRow(existing);
      return true;
    }

    // advance: re-read and compare-and-set on pinnedAik — another concurrent validation
    // may have moved the pin while we awaited the fetch.
    const fresh = await readTrustRow(userId);
    if (!fresh || fresh.pinnedAik !== existing.pinnedAik) {
      // Lost the race. The pin already moved (linear chain ⇒ both walks follow the same
      // path); accept if our candidate is now the pin or already in the advanced history.
      return !!fresh && (fresh.pinnedAik === aikB64 || (fresh.aikHistory ?? []).includes(aikB64));
    }
    fresh.pinnedAik = verdict.newPin;
    fresh.pinnedSeq = verdict.newSeq;
    fresh.aikHistory = verdict.history;
    fresh.rotatedAt = now;
    fresh.lastSeen = now;
    // Verified-state hybrid (E): an unverified pin advances silently (no human assertion
    // to weaken — the whole stranded-DM surface today is unverified TOFU pins). A
    // verified pin rides continuity for the rotation but DROPS verified: the old-AIK
    // holder cannot inherit the human safety-number badge; re-verification is required.
    if (fresh.verified) fresh.verified = false;
    addDevice(fresh, device, now);
    await writeTrustRow(fresh);
    return true;
  });
}

// Device wrap key
// ONE non-extractable AES-GCM-256 CryptoKey stored DIRECTLY (structured clone) in
// STORE_DEVICEKEY under id 'mls-device-wrap'. It wraps the per-device MLS identity
// + KeyPackage privates at rest (wrapVersion 2) so they survive WITHOUT the vault
// password - the always-needed device-identity wrap. DISTINCT from dmKeyManager's
// howl_e2e_wrap content-remember key, which forgetDevice()/idle-lock DESTROY; this
// key is destroyed ONLY by encryption-reset / clearAll, never by lock/idle-lock.
// Reachable from BOTH the main thread and the SharedWorker (IDB is origin-global);
// the worker calls this accessor itself at init - the key is NEVER sent over the
// init postMessage payload.
const DEVICE_WRAP_KEY_ID = 'mls-device-wrap';

interface DeviceKeyRecord {
  id: string;      // keyPath; always DEVICE_WRAP_KEY_ID
  key: CryptoKey;  // non-extractable; stored via structured clone (raw bytes unreachable)
}

export async function getOrCreateDeviceWrapKey(): Promise<CryptoKey> {
  const db = await getDb();
  const existing = (await db.get(STORE_DEVICEKEY, DEVICE_WRAP_KEY_ID)) as DeviceKeyRecord | undefined;
  if (existing && existing.key instanceof CryptoKey) return existing.key;
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable - raw bytes unreachable from JS
    ['encrypt', 'decrypt'],
  );
  await db.put(STORE_DEVICEKEY, { id: DEVICE_WRAP_KEY_ID, key } satisfies DeviceKeyRecord);
  return key;
}

// Logout

export async function clearAll(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_GROUPS, STORE_KP, STORE_META, STORE_HISTORY, STORE_IDENTITY, STORE_DEVICEKEY, STORE_TRUST, STORE_TOMBSTONE], 'readwrite');
  await tx.objectStore(STORE_GROUPS).clear();
  await tx.objectStore(STORE_KP).clear();
  await tx.objectStore(STORE_META).clear();
  await tx.objectStore(STORE_HISTORY).clear();
  await tx.objectStore(STORE_IDENTITY).clear();
  await tx.objectStore(STORE_DEVICEKEY).clear();
  await tx.objectStore(STORE_TRUST).clear();
  await tx.objectStore(STORE_TOMBSTONE).clear(); // tombstones cleared only on full account reset
  await tx.done;
}

// Re-key

/**
 * Re-keys ONLY the vault-keyed stores (groups + history). The per-device MLS
 * identity + KP privates ride the persistent device wrap, so a vault
 * password change never rotates them - avoiding the orphan-then-re-mint storm a
 * Server-mode password change would otherwise cause.
 *
 * Re-encrypt the durable at-rest stores from old keys to new keys,
 * used by the in-session password/passphrase-change flows so a salt rotation does
 * not orphan the Saved-history archive. The NEW keys MUST be the ones the next
 * unlock will derive (deriveUnlockMaterial(newPassword, newSalt)).
 * Per-row graceful: a history row that fails re-key is DELETED (no dead row that
 * masquerades as a cache miss); a group row that fails is left to self-heal via
 * MLS re-sync. No-op on empty stores. Skips history if either history key is null.
 *
 * NOTE: this re-encrypts EACH row under a FRESH IV and writes it back. A concurrent
 * read CAN still interleave mid-loop (the worker dispatches commits fire-and-forget),
 * reading a row already rewritten under the new key while the old key is installed — a
 * stale-key OperationError. The caller (core.rekey) latches a re-key barrier so the
 * orphaned-row heal treats that as a transient artifact instead of dropping the live
 * row. It does NOT swap the module-held keys; the caller does that after this resolves.
 */
export async function rekeyAtRestStores(
  oldAtRestKey: CryptoKey,
  newAtRestKey: CryptoKey,
  oldHistoryKey: CryptoKey | null,
  newHistoryKey: CryptoKey | null,
): Promise<void> {
  const db = await getDb();

  // Groups: decrypt under old at-rest -> re-encrypt under new at-rest -> put. On a
  // per-row failure, leave the row UNTOUCHED — a stale (old-key) group row self-heals
  // via the next MLS catch-up/welcome re-sync; deleting it would orphan the channel.
  const groupRows = (await db.getAll(STORE_GROUPS)) as GroupRecord[];
  for (const rec of groupRows) {
    try {
      const snapshot = await decryptWithKey(oldAtRestKey, rec.encryptedSnapshot, rec.iv);
      const { ct, iv } = await encryptWithKey(newAtRestKey, snapshot);
      await db.put(STORE_GROUPS, { ...rec, encryptedSnapshot: ct, iv });
    } catch (err) {
      logger.warn('mlsGroupStore: group re-key failed; left for MLS re-sync', {
        error: (err as Error)?.name,
      });
    }
  }

  // History: only when BOTH keys are present (a null history key = Self-recovery user
  // with no archive). Decrypt under old history -> re-encrypt under new history -> put.
  // On a per-row failure, DELETE the row: a row that can't be re-keyed is unreadable
  // under the new key forever, and leaving it would masquerade as a cache miss on the
  // delete-write-through path; the message simply re-decrypts live next load.
  if (oldHistoryKey && newHistoryKey) {
    const historyRows = (await db.getAll(STORE_HISTORY)) as HistoryRecord[];
    for (const rec of historyRows) {
      try {
        const pt = await decryptWithKey(oldHistoryKey, rec.encryptedPlaintext, rec.iv);
        const { ct, iv } = await encryptWithKey(newHistoryKey, pt);
        await db.put(STORE_HISTORY, { ...rec, encryptedPlaintext: ct, iv });
      } catch (err) {
        logger.warn('mlsGroupStore: history re-key failed; row dropped (re-decrypts live)', {
          error: (err as Error)?.name,
        });
        await db.delete(STORE_HISTORY, rec.key);
      }
    }
  }
}

/** Clear ONLY the history archive (recovery flows: archive is unrecoverable). */
export async function clearHistory(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE_HISTORY);
}

// Test-only hooks
// Exposed solely for __tests__/mlsGroupStore.test.ts. The eviction path and the
// cap are otherwise unobservable without inserting MAX_GROUPS+1 real groups.
export const __testHooks = {
  logger,
  setMaxGroupsForTest(n: number) {
    maxGroups = n;
  },
  setMaxHistoryForTest(n: number) {
    maxHistory = n;
  },
  resetDbHandle() {
    dbPromise = null;
  },
  /**
   * Deterministically exercise the blocking()-handler reopen path: close the live
   * connection and null the cached promise (exactly what blocking() does), so the
   * next getDb() must transparently reopen. fake-indexeddb does not reliably fire a
   * real `blocking` event from a same-process cross-connection upgrade, so the
   * close+null logic is driven directly here. Awaits the close so the next reopen
   * is observable.
   */
  async simulateBlockingForTest() {
    const db = await Promise.resolve(dbPromise);
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    dbPromise = null;
  },
  /** Reset rotation-attestation module state between trust-store tests. */
  resetRotationStateForTest() {
    _rotationChainFetcher = null;
    _chainCache.clear();
    _trustLocks.clear();
  },
  /** Seed a full TrustRecord (e.g. a verified pin) for tests; round-trips writeTrustRow. */
  async writeTrustRecordForTest(rec: TrustRecord) {
    await writeTrustRow(rec);
  },
};
