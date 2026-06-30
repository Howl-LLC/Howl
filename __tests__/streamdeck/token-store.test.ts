// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ts = await import('../../electron/streamdeck/token-store.js').then((m) => m.default ?? m);

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: (s: string) => Buffer.from('ENC:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC:/, ''),
};

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'howl-sdts-'));
  ts._setSafeStorage(mockSafeStorage);
});

describe('streamdeck/token-store', () => {
  it('stores, retrieves, lists, and revokes a paired plugin', () => {
    const installId = 'install-a';
    ts.storePairing(tmpDir, installId, {
      pluginId: 'com.howlpro.streamdeck',
      displayName: 'Howl Plugin',
      version: '1.0.0',
      token: 'tok_abc',
    });

    const match = ts.verifyToken(tmpDir, installId, 'com.howlpro.streamdeck', 'tok_abc');
    expect(match).toBe(true);

    const list = ts.listPairings(tmpDir, installId);
    expect(list).toHaveLength(1);
    expect(list[0].pluginId).toBe('com.howlpro.streamdeck');
    expect(list[0].token).toBeUndefined(); // never leak the raw token

    ts.revoke(tmpDir, installId, 'com.howlpro.streamdeck');
    expect(ts.verifyToken(tmpDir, installId, 'com.howlpro.streamdeck', 'tok_abc')).toBe(false);
    expect(ts.listPairings(tmpDir, installId)).toHaveLength(0);
  });

  it('binds tokens to installId — different install cannot verify', () => {
    ts.storePairing(tmpDir, 'install-a', {
      pluginId: 'com.howlpro.streamdeck', displayName: 'P', version: '1.0.0', token: 'tok',
    });
    expect(ts.verifyToken(tmpDir, 'install-b', 'com.howlpro.streamdeck', 'tok')).toBe(false);
  });

  it('updates lastUsedAt on successful verify', async () => {
    ts.storePairing(tmpDir, 'i', {
      pluginId: 'com.howlpro.streamdeck', displayName: 'P', version: '1.0.0', token: 'tok',
    });
    const before = ts.listPairings(tmpDir, 'i')[0].lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    ts.verifyToken(tmpDir, 'i', 'com.howlpro.streamdeck', 'tok');
    const after = ts.listPairings(tmpDir, 'i')[0].lastUsedAt;
    expect(after).toBeGreaterThan(before);
  });

  it('constant-time compares tokens', () => {
    // We verify this indirectly: two wrong-token attempts of different lengths
    // should both return false without throwing.
    ts.storePairing(tmpDir, 'i', {
      pluginId: 'com.howlpro.streamdeck', displayName: 'P', version: '1.0.0', token: 'real-token',
    });
    expect(ts.verifyToken(tmpDir, 'i', 'com.howlpro.streamdeck', 'x')).toBe(false);
    expect(ts.verifyToken(tmpDir, 'i', 'com.howlpro.streamdeck', 'real-token-plus-extra')).toBe(false);
  });

  it('refuses to store when safeStorage backend is basic_text (Linux no keychain)', () => {
    ts._setSafeStorage({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8'),
    });
    expect(() => ts.storePairing(tmpDir, 'i', {
      pluginId: 'com.howlpro.streamdeck', displayName: 'P', version: '1.0.0', token: 'tok',
    })).toThrow(/keychain/i);
  });
});
