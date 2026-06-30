// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Client-side search index for E2E encrypted DM messages.
 *
 * Uses MiniSearch for in-memory full-text search and IndexedDB for persistent
 * storage of decrypted message data. The search index runs entirely on the
 * client -- no search queries ever reach the server for encrypted DMs.
 *
 * The IndexedDB database is scoped per-user (`howl-dm-search-${userId}`) so
 * that a failed logout cleanup cannot leak decrypted messages to another user.
 */
import MiniSearch from 'minisearch';
import { openDB, type IDBPDatabase } from 'idb';
import type { Message } from '../types';
import { getHistoryKey } from './mls/mlsGroupStore';

const DB_NAME_PREFIX = 'howl-dm-search';
/** Legacy global DB name — deleted on init as a migration safety net. */
const LEGACY_DB_NAME = 'howl-dm-search';
/** v2: `content` is now stored as AES-GCM ciphertext at rest. */
const DB_VERSION = 2;
const STORE_NAME = 'messages';
const META_STORE = 'meta';

interface StoredMessage {
  id: string;
  dmChannelId: string;
  authorId: string;
  authorUsername?: string;
  /** AES-GCM(historyKey, utf8(content)) — message plaintext never at rest. */
  contentCt: ArrayBuffer;
  contentIv: ArrayBuffer;
  timestamp: number;
}

// At-rest content crypto (mirrors mlsGroupStore.encryptWithKey/decryptWithKey)
// Keyed by the vault historyKey: set on unlock, nulled on lock. While null we
// cannot persist (writes skip) and cannot read (reads fail closed → empty).

async function sealContent(plaintext: string): Promise<{ ct: ArrayBuffer; iv: ArrayBuffer } | null> {
  const k = getHistoryKey();
  if (!k) return null; // locked: cannot persist (caller skips the write)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plaintext));
  return { ct, iv: iv.buffer };
}

async function openContent(ct: ArrayBuffer, iv: ArrayBuffer): Promise<string | null> {
  const k = getHistoryKey();
  if (!k) return null; // locked: fail closed
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, k, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** The plaintext document shape MiniSearch indexes (RAM only, dropped on lock). */
interface IndexedDoc {
  id: string;
  dmChannelId: string;
  authorId: string;
  authorUsername?: string;
  content: string;
  timestamp: number;
}

interface SyncMeta {
  key: string;
  dmChannelId: string;
  oldestMessageId?: string;
  newestMessageId?: string;
  messageCount: number;
  lastSyncedAt: number;
}

let searchIndex: MiniSearch | null = null;
let dbPromise: Promise<IDBPDatabase> | null = null;
let indexedChannels = new Set<string>();
let currentUserId: string | null = null;

function dbName(userId: string): string {
  return `${DB_NAME_PREFIX}-${userId}`;
}

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    if (!currentUserId) throw new Error('DM search index: initSearchIndex() must be called first');
    dbPromise = openDB(dbName(currentUserId), DB_VERSION, {
      upgrade(db) {
        // v2: the messages store now holds ciphertext, not plaintext.
        // There is no prior store to migrate — recreate the store so no plaintext
        // row from a v1 index survives the shape change.
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by-channel', 'dmChannelId');
        store.createIndex('by-timestamp', 'timestamp');
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

function getOrCreateIndex(): MiniSearch {
  if (!searchIndex) {
    searchIndex = new MiniSearch({
      fields: ['content', 'authorUsername'],
      storeFields: ['dmChannelId', 'authorId', 'authorUsername', 'content', 'timestamp'],
      searchOptions: {
        boost: { content: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }
  return searchIndex;
}

/**
 * Initialize the search index for a specific user. Must be called before
 * any other search index operation. Deletes the legacy global database
 * as a migration safety net.
 */
export async function initSearchIndex(userId: string): Promise<void> {
  // If switching users, close the old DB
  if (currentUserId && currentUserId !== userId) {
    searchIndex = null;
    indexedChannels = new Set();
    if (dbPromise) {
      const db = await dbPromise.catch(() => null);
      db?.close();
    }
    dbPromise = null;
  }
  currentUserId = userId;
  // Delete the legacy global database (migration safety net)
  try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch { /* best-effort */ }
}

export async function indexDMMessages(
  dmChannelId: string,
  messages: Message[],
): Promise<void> {
  const db = await getDB();
  const index = getOrCreateIndex();

  // Seal all content BEFORE opening the IDB transaction: an `await` on a
  // non-IDB promise (WebCrypto) between IDB requests would let the transaction
  // auto-commit, so all async crypto must complete first.
  const prepared: { stored: StoredMessage; indexed: IndexedDoc }[] = [];
  for (const msg of messages) {
    if (msg.type === 'system') continue;
    if (!msg.content || msg.content.startsWith('🔒')) continue;

    const sealed = await sealContent(msg.content);
    if (!sealed) continue; // locked: cannot persist (skip IDB + in-memory)

    const timestamp = msg.timestamp.getTime();
    prepared.push({
      stored: {
        id: msg.id,
        dmChannelId,
        authorId: msg.authorId,
        authorUsername: msg.authorUsername,
        contentCt: sealed.ct,
        contentIv: sealed.iv,
        timestamp,
      },
      indexed: {
        id: msg.id,
        dmChannelId,
        authorId: msg.authorId,
        authorUsername: msg.authorUsername,
        content: msg.content,
        timestamp,
      },
    });
  }

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const { stored } of prepared) {
    await store.put(stored);
  }
  await tx.done;

  for (const { indexed } of prepared) {
    try {
      if (index.has(indexed.id)) {
        index.discard(indexed.id);
      }
      index.add(indexed);
    } catch {
      // Silently skip indexing errors for individual messages
    }
  }

  indexedChannels.add(dmChannelId);

  const meta: SyncMeta = {
    key: dmChannelId,
    dmChannelId,
    messageCount: messages.length,
    lastSyncedAt: Date.now(),
    oldestMessageId: messages[0]?.id,
    newestMessageId: messages[messages.length - 1]?.id,
  };
  const metaTx = db.transaction(META_STORE, 'readwrite');
  await metaTx.objectStore(META_STORE).put(meta);
  await metaTx.done;
}

export async function addMessageToIndex(
  dmChannelId: string,
  message: Message,
): Promise<void> {
  if (message.type === 'system') return;
  if (!message.content || message.content.startsWith('🔒')) return;

  const sealed = await sealContent(message.content);
  if (!sealed) return; // locked: cannot persist (skip IDB + in-memory)

  const db = await getDB();
  const index = getOrCreateIndex();

  const doc: StoredMessage = {
    id: message.id,
    dmChannelId,
    authorId: message.authorId,
    authorUsername: message.authorUsername,
    contentCt: sealed.ct,
    contentIv: sealed.iv,
    timestamp: message.timestamp.getTime(),
  };

  const tx = db.transaction(STORE_NAME, 'readwrite');
  await tx.objectStore(STORE_NAME).put(doc);
  await tx.done;

  const indexedDoc: IndexedDoc = {
    id: message.id,
    dmChannelId,
    authorId: message.authorId,
    authorUsername: message.authorUsername,
    content: message.content,
    timestamp: message.timestamp.getTime(),
  };
  try {
    if (index.has(message.id)) {
      index.discard(message.id);
    }
    index.add(indexedDoc);
  } catch {
    // Skip
  }
}

export async function removeMessageFromIndex(messageId: string): Promise<void> {
  const db = await getDB();
  const index = getOrCreateIndex();

  const tx = db.transaction(STORE_NAME, 'readwrite');
  await tx.objectStore(STORE_NAME).delete(messageId);
  await tx.done;

  try {
    if (index.has(messageId)) {
      index.discard(messageId);
    }
  } catch {
    // Skip
  }
}

export async function updateMessageInIndex(
  messageId: string,
  newContent: string,
): Promise<void> {
  const sealed = await sealContent(newContent);
  if (!sealed) return; // locked: cannot persist the updated content (fail closed)

  const db = await getDB();
  const index = getOrCreateIndex();

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const existing: StoredMessage | undefined = await tx.objectStore(STORE_NAME).get(messageId);
  if (existing) {
    existing.contentCt = sealed.ct;
    existing.contentIv = sealed.iv;
    await tx.objectStore(STORE_NAME).put(existing);
  }
  await tx.done;

  try {
    if (index.has(messageId)) {
      index.discard(messageId);
    }
    if (existing) {
      index.add({
        id: existing.id,
        dmChannelId: existing.dmChannelId,
        authorId: existing.authorId,
        authorUsername: existing.authorUsername,
        content: newContent,
        timestamp: existing.timestamp,
      } satisfies IndexedDoc);
    }
  } catch {
    // Skip
  }
}

export interface DMSearchResult {
  id: string;
  dmChannelId: string;
  authorId: string;
  authorUsername?: string;
  content: string;
  timestamp: number;
  score: number;
}

export interface DMSearchResponse {
  results: DMSearchResult[];
  /** True when the search index may not cover all messages (e.g. older messages not yet loaded). */
  mayBeIncomplete: boolean;
}

export function searchDMMessages(
  query: string,
  dmChannelId?: string,
  limit = 50,
): DMSearchResponse {
  const index = getOrCreateIndex();

  let results = index.search(query);

  if (dmChannelId) {
    results = results.filter((r) => r.dmChannelId === dmChannelId);
  }

  return {
    results: results.slice(0, limit).map((r) => ({
      id: r.id,
      dmChannelId: r.dmChannelId,
      authorId: r.authorId,
      authorUsername: r.authorUsername,
      content: r.content,
      timestamp: r.timestamp,
      score: r.score,
    })),
    // Client-side index can never guarantee full coverage without scrolling all history
    mayBeIncomplete: true,
  };
}

/** Maximum messages to load into the in-memory MiniSearch index.
 *  Older messages are still searchable via the IDB cursor fallback. */
const IN_MEMORY_INDEX_CAP = 50_000;

export async function loadIndexFromDB(): Promise<number> {
  const db = await getDB();
  const index = getOrCreateIndex();

  // Walk the by-timestamp index in descending order (newest first) so the
  // most recent rows are collected up to the cap. Collect rows WITHOUT any
  // non-IDB await in the cursor loop (a WebCrypto await would auto-commit the
  // readonly tx), then decrypt + index after the read completes.
  const tx = db.transaction(STORE_NAME, 'readonly');
  const timestampIndex = tx.objectStore(STORE_NAME).index('by-timestamp');
  let cursor = await timestampIndex.openCursor(null, 'prev');
  const rows: StoredMessage[] = [];

  while (cursor && rows.length < IN_MEMORY_INDEX_CAP) {
    rows.push(cursor.value);
    cursor = await cursor.continue();
  }

  await tx.done;

  let count = 0;
  for (const doc of rows) {
    const content = await openContent(doc.contentCt, doc.contentIv);
    if (content === null) continue; // locked or undecryptable — skip
    try {
      if (!index.has(doc.id)) {
        index.add({
          id: doc.id,
          dmChannelId: doc.dmChannelId,
          authorId: doc.authorId,
          authorUsername: doc.authorUsername,
          content,
          timestamp: doc.timestamp,
        } satisfies IndexedDoc);
        count++;
        indexedChannels.add(doc.dmChannelId);
      }
    } catch {
      // Skip individual failures
    }
  }
  return count;
}

export async function getIndexStats(): Promise<{
  totalMessages: number;
  channelCount: number;
  storageEstimate: string;
}> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const count = await tx.objectStore(STORE_NAME).count();
  await tx.done;

  let storageEstimate = 'unknown';
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const usedMB = ((estimate.usage ?? 0) / (1024 * 1024)).toFixed(1);
    storageEstimate = `${usedMB}MB`;
  }

  return {
    totalMessages: count,
    channelCount: indexedChannels.size,
    storageEstimate,
  };
}

/**
 * Tear down the DM search index at session end.
 *
 * The persisted index is AES-GCM ciphertext at rest (sealed under the vault
 * historyKey) and is fully rebuildable from messages, so EVERY session end —
 * full sign-out AND idle-lock / cross-tab-logout / server-session-expiry — DELETEs
 * it, never merely closes the handle. Defense-in-depth: even though the rows are
 * encrypted, a deliberate key-scrub should not leave a history that a same-user
 * re-login would silently resurrect, and deletion guarantees no stale rows outlive
 * a historyKey rotation. This is the single teardown contract both `cleanupSession`
 * branches call.
 */
export async function teardownSearchIndexForSessionEnd(): Promise<void> {
  await clearSearchIndex();
}

export async function closeDmSearchDB(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    if (db) db.close();
    dbPromise = null;
  }
}

/**
 * On vault lock (incl. idle-lock), drop the in-memory MiniSearch (its storeFields
 * hold decrypted plaintext in RAM) and close the IDB handle. Search across
 * idle-lock then returns empty (fail closed) until onUnlocked rebuilds the index
 * by decrypting the at-rest store under the restored key.
 */
export async function onLocked(): Promise<void> {
  searchIndex = null;        // drop the in-memory MiniSearch (plaintext storeFields)
  await closeDmSearchDB();   // close the IDB handle
}

/**
 * On vault unlock, re-init the user-scoped DB and rebuild the in-memory
 * MiniSearch by decrypting the at-rest store under the restored historyKey.
 */
export async function onUnlocked(userId: string): Promise<void> {
  await initSearchIndex(userId);
  await loadIndexFromDB(); // rebuilds MiniSearch by decrypting under the restored historyKey
}

export async function clearSearchIndex(): Promise<void> {
  searchIndex = null;
  indexedChannels = new Set();
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    if (db) {
      try {
        const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
        await tx.objectStore(STORE_NAME).clear();
        await tx.objectStore(META_STORE).clear();
        await tx.done;
      } catch { /* DB may already be deleted */ }
      db.close();
    }
  }
  dbPromise = null;
  // Delete the user-scoped database entirely
  if (currentUserId) {
    try { indexedDB.deleteDatabase(dbName(currentUserId)); } catch { /* best-effort */ }
  }
  // Also delete the legacy global database as a safety net
  try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch { /* best-effort */ }
  currentUserId = null;
}

export async function evictOldMessages(
  maxAgeDays = 60,
  maxMessages = 200000,
): Promise<number> {
  const db = await getDB();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const timestampIndex = store.index('by-timestamp');

  let evicted = 0;
  let cursor = await timestampIndex.openCursor();

  while (cursor) {
    if (cursor.value.timestamp < cutoff) {
      const id = cursor.value.id;
      await cursor.delete();
      try {
        if (searchIndex?.has(id)) {
          searchIndex.discard(id);
        }
      } catch { /* skip */ }
      evicted++;
    } else {
      break;
    }
    cursor = await cursor.continue();
  }

  await tx.done;

  const totalCount = await db.transaction(STORE_NAME, 'readonly')
    .objectStore(STORE_NAME).count();

  if (totalCount > maxMessages) {
    const excess = totalCount - maxMessages;
    const tx2 = db.transaction(STORE_NAME, 'readwrite');
    const store2 = tx2.objectStore(STORE_NAME);
    const cursor2 = await store2.index('by-timestamp').openCursor();
    let removed = 0;
    let c = cursor2;
    while (c && removed < excess) {
      const id = c.value.id;
      await c.delete();
      try {
        if (searchIndex?.has(id)) {
          searchIndex.discard(id);
        }
      } catch { /* skip */ }
      removed++;
      evicted++;
      c = await c.continue();
    }
    await tx2.done;
  }

  return evicted;
}

/**
 * Cursor-based search that scans IndexedDB directly.
 * Used for messages older than the MiniSearch in-memory cap.
 * Walks the 'by-timestamp' index in descending order so newest
 * matches are returned first.
 */
export async function searchDmMessagesFromDB(
  query: string,
  dmChannelId?: string,
  limit = 50,
  excludeIds?: Set<string>,
): Promise<DMSearchResult[]> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  // Fail closed while locked: no historyKey means no decryptable content.
  if (!getHistoryKey()) return [];
  const terms = trimmed.split(/\s+/).filter(Boolean);

  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const timestampIndex = store.index('by-timestamp');

  // Collect candidate rows (cheap synchronous filters only) newest-first WITHOUT
  // a non-IDB await in the cursor loop — decryption (a WebCrypto await) would
  // auto-commit the readonly tx — then decrypt + substring-match afterwards.
  const candidates: StoredMessage[] = [];
  let cursor = await timestampIndex.openCursor(null, 'prev');
  while (cursor) {
    const doc: StoredMessage = cursor.value;
    if (!excludeIds?.has(doc.id) && !(dmChannelId && doc.dmChannelId !== dmChannelId)) {
      candidates.push(doc);
    }
    cursor = await cursor.continue();
  }

  await tx.done;

  const results: DMSearchResult[] = [];
  for (const doc of candidates) {
    // Decrypt the at-rest content before substring-matching; skip rows that
    // fail to decrypt (e.g. key rotated out mid-scan).
    const content = await openContent(doc.contentCt, doc.contentIv);
    if (content === null) continue;

    // Check if all terms appear in content or authorUsername (case-insensitive)
    const haystack = `${content} ${doc.authorUsername ?? ''}`.toLowerCase();
    if (terms.every(t => haystack.includes(t))) {
      results.push({
        id: doc.id,
        dmChannelId: doc.dmChannelId,
        authorId: doc.authorId,
        authorUsername: doc.authorUsername,
        content,
        timestamp: doc.timestamp,
        score: 0, // IDB scan has no relevance score
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Hybrid search: combines MiniSearch (instant, in-memory) with IDB
 * (full scan for older messages not loaded into memory).
 *
 * Returns instant results synchronously and a thunk to fetch older
 * matches from IndexedDB on demand.
 */
export function searchDmMessagesHybrid(
  query: string,
  dmChannelId?: string,
  limit = 50,
): { instant: DMSearchResponse; fetchOlder: () => Promise<DMSearchResult[]> } {
  const instantResult = searchDMMessages(query, dmChannelId, limit);
  const instantIds = new Set(instantResult.results.map(r => r.id));

  return {
    instant: instantResult,
    fetchOlder: () => searchDmMessagesFromDB(query, dmChannelId, limit, instantIds),
  };
}

export function isChannelIndexed(dmChannelId: string): boolean {
  return indexedChannels.has(dmChannelId);
}
