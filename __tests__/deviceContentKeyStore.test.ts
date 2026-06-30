// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Device content-key persistence store.
 *
 * Stores the three NON-EXTRACTABLE content CryptoKeys (blobKey/atRestKey/
 * historyKey) directly (structured clone) in a dedicated IndexedDB store, so a
 * passwordless boot can install the vault without re-running Argon2id. Self
 * mode = opt-in, 30-day sliding TTL; Server mode = always-on, no TTL.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

import {
  putContentKeys,
  loadContentKeys,
  clearContentKeys,
  hasFreshContentKeys,
  __resetDbHandle,
} from '../services/deviceContentKeyStore';

async function freshKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('deviceContentKeyStore', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    vi.useRealTimers();
  });

  it('round-trips the three CryptoKeys for Self mode and reports fresh', async () => {
    const blobKey = await freshKey();
    const atRestKey = await freshKey();
    const historyKey = await freshKey();
    await putContentKeys({ blobKey, atRestKey, historyKey, mode: 'self' });

    expect(await hasFreshContentKeys()).toBe(true);
    const loaded = await loadContentKeys();
    expect(loaded).not.toBeNull();
    expect(loaded!.mode).toBe('self');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, loaded!.blobKey, new TextEncoder().encode('hi'));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, blobKey, ct);
    expect(new TextDecoder().decode(pt)).toBe('hi');
  });

  it('Self mode expires after the 30-day TTL — load returns null and clears the row', async () => {
    const blobKey = await freshKey();
    const atRestKey = await freshKey();
    const historyKey = await freshKey();
    await putContentKeys({ blobKey, atRestKey, historyKey, mode: 'self' });

    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000;
    try {
      expect(await hasFreshContentKeys()).toBe(false);
      expect(await loadContentKeys()).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(await loadContentKeys()).toBeNull();
  });

  it('Server mode has NO TTL — still fresh far in the future', async () => {
    const blobKey = await freshKey();
    const atRestKey = await freshKey();
    const historyKey = await freshKey();
    await putContentKeys({ blobKey, atRestKey, historyKey, mode: 'server' });

    const realNow = Date.now;
    Date.now = () => realNow() + 365 * 24 * 60 * 60 * 1000;
    try {
      expect(await hasFreshContentKeys()).toBe(true);
      const loaded = await loadContentKeys();
      expect(loaded!.mode).toBe('server');
    } finally {
      Date.now = realNow;
    }
  });

  it('refreshes the sliding TTL on a fresh Self load', async () => {
    const blobKey = await freshKey();
    const atRestKey = await freshKey();
    const historyKey = await freshKey();
    await putContentKeys({ blobKey, atRestKey, historyKey, mode: 'self' });

    const realNow = Date.now;
    Date.now = () => realNow() + 20 * 24 * 60 * 60 * 1000;
    try {
      expect(await loadContentKeys()).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
    Date.now = () => realNow() + 40 * 24 * 60 * 60 * 1000;
    try {
      expect(await hasFreshContentKeys()).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('clearContentKeys removes the row', async () => {
    const blobKey = await freshKey();
    const atRestKey = await freshKey();
    const historyKey = await freshKey();
    await putContentKeys({ blobKey, atRestKey, historyKey, mode: 'server' });
    await clearContentKeys();
    expect(await loadContentKeys()).toBeNull();
    expect(await hasFreshContentKeys()).toBe(false);
  });
});
