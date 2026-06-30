// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Move-to-Private - the history upload syncer must stamp each uploaded row's
 * keyVersion with the LIVE archiveKey generation (dmKeyManager.getArchiveKeyVersion())
 * rather than a hard-coded literal, so that after the archiveKey rotates the
 * re-uploaded rows carry the new generation.
 *
 * Strategy mirrors __tests__/mlsHistoryArchiveSync.test.ts: exercise the REAL
 * mlsGroupStore against fake-indexeddb with a real AES-256-GCM historyKey and REAL
 * crypto.subtle for the seal, mocking only the gate dependencies. The dmKeyManager
 * mock reports getArchiveKeyVersion() === 2; we assert the POSTed item carries
 * keyVersion === 2 (not the old literal 1).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import * as store from '../services/mls/mlsGroupStore';
import * as sync from '../services/mls/mlsHistoryArchiveSync';

// Hoisted mock state (gate dependencies)
const mocks = vi.hoisted(() => ({
  postDmHistoryArchive: vi.fn(),
  getArchiveKey: vi.fn(),
  getArchiveKeyVersion: vi.fn(),
  getMinAcceptableArchiveKeyVersion: vi.fn(() => 1),
  isArchiveKeyPersisted: vi.fn(),
  isRekeyInProgress: vi.fn(),
  isUnlocked: vi.fn(),
  hasHistorySyncLease: vi.fn(),
  acquireHistorySyncLease: vi.fn(),
  releaseHistorySyncLease: vi.fn(),
}));

vi.mock('../services/api', () => ({
  apiClient: { postDmHistoryArchive: mocks.postDmHistoryArchive },
}));
vi.mock('../services/dmKeyManager', () => ({
  getArchiveKey: mocks.getArchiveKey,
  getArchiveKeyVersion: mocks.getArchiveKeyVersion,
  getMinAcceptableArchiveKeyVersion: mocks.getMinAcceptableArchiveKeyVersion,
  isArchiveKeyPersisted: mocks.isArchiveKeyPersisted,
  isRekeyInProgress: mocks.isRekeyInProgress,
  isUnlocked: mocks.isUnlocked,
}));
vi.mock('../services/mls/mlsHistoryLocks', () => ({
  acquireHistorySyncLease: mocks.acquireHistorySyncLease,
  hasHistorySyncLease: mocks.hasHistorySyncLease,
  releaseHistorySyncLease: mocks.releaseHistorySyncLease,
}));
vi.mock('../services/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const USER = '00000000-0000-4000-8000-0000000000f0';
const CH = '00000000-0000-4000-8000-0000000000a1';
const ENV = JSON.stringify({ v: 4, m: 'AAEAAg==' });

async function makeHistoryKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Pump the macrotask queue until a predicate holds (the fire-and-forget drain
// chains many awaits before the POST lands).
async function settle(predicate: () => boolean | Promise<boolean>, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

let archiveKeyBytes: Uint8Array;

beforeEach(() => {
  sync.stopHistorySync();
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(null);
  store.setHistoryKey(null);

  archiveKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  mocks.postDmHistoryArchive.mockReset().mockResolvedValue({ stored: 0 });
  mocks.getArchiveKey.mockReset().mockReturnValue(archiveKeyBytes);
  mocks.getArchiveKeyVersion.mockReset().mockReturnValue(2); // rotated generation
  mocks.getMinAcceptableArchiveKeyVersion.mockReset().mockReturnValue(1);
  mocks.isArchiveKeyPersisted.mockReset().mockReturnValue(true);
  mocks.isRekeyInProgress.mockReset().mockReturnValue(false);
  mocks.isUnlocked.mockReset().mockReturnValue(true);
  mocks.hasHistorySyncLease.mockReset().mockReturnValue(true);
  mocks.acquireHistorySyncLease.mockReset().mockResolvedValue(true);
  mocks.releaseHistorySyncLease.mockReset();
});

afterEach(() => {
  sync.stopHistorySync();
  store.setAtRestKey(null);
  store.setHistoryKey(null);
});

describe('mlsHistoryArchiveSync - keyVersion stamping', () => {
  it('stamps the POSTed item with the live archiveKeyVersion (2), not the old literal 1', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);

    expect(mocks.postDmHistoryArchive).toHaveBeenCalledTimes(1);
    const items = mocks.postDmHistoryArchive.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect(items[0].keyVersion).toBe(2);
    expect(mocks.getArchiveKeyVersion).toHaveBeenCalled();

    sync.stopHistorySync();
  });
});
