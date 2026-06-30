// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * A channel never classified 'mls' (getChannelProtocol null) is
 * fail-closed AND healable. encrypt throws; decrypt yields the placeholder
 * stamped with undecryptable + _encryptedEnvelope (and the reply stash) so
 * useMlsRedecrypt recovers the rows once the channel classifies, without a
 * reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../types';

// isChannelMls is a mutable flag so we can model the socket-ordering race:
// the rows arrive while the channel is unclassified (false), then the Welcome
// drain classifies it (flip to true) and the heal sweep re-decrypts.
let mlsClassified = false;
vi.mock('../services/encryptionFlags', () => ({
  isChannelMls: vi.fn(() => mlsClassified),
  setChannelEncryptionStatus: vi.fn(),
  isChannelEncrypted: vi.fn(() => false),
  isChannelEncryptionKnown: vi.fn(() => false),
  clearEncryptionStatus: vi.fn(),
}));

// mlsCoordinator.decrypt is unused on the unclassified path; once classified it
// resolves the plaintext so the heal sweep recovers the row.
vi.mock('../services/mls/mlsCoordinator', () => ({
  isReadyForChannel: vi.fn(() => true),
  encrypt: vi.fn(async () => JSON.stringify({ v: 4, m: 'AAAA' })),
  decrypt: vi.fn(async () => 'hello'),
  mlsEvents: { on: vi.fn(() => () => {}) },
}));

vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: vi.fn(() => true),
  isSetup: vi.fn(() => true),
  getChannelKey: vi.fn(() => null),
  getChannelKeyEntries: vi.fn(() => []),
  on: vi.fn(() => () => {}),
}));

import {
  encryptDMContent,
  decryptDMMessages,
  decryptSingleDMMessage,
  decryptDMContent,
  ENCRYPTED_PLACEHOLDER,
  initializeEncryption,
} from '../services/dmEncryption';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';

// m MUST be valid base64 (length % 4 === 0): isMlsEnvelopeV4 atob-decodes it
// and returns false on a decode throw, which would silently route the fixture
// down the passthrough arm and vacuously fail the stamp assertions.
const V4 = JSON.stringify({ v: 4, m: 'AAAA' });

beforeEach(() => {
  mlsClassified = false;
  vi.clearAllMocks();
  (mlsCoordinator.decrypt as any).mockResolvedValue('hello');
  initializeEncryption('alice');
});

describe('unclassified channel (fail-closed + healable)', () => {
  it('encryptDMContent throws Encryption unavailable', async () => {
    await expect(encryptDMContent('chan-x', 'hi')).rejects.toThrow(/Encryption unavailable/);
  });

  it('decryptDMMessages stamps the placeholder healable', async () => {
    const msgs = [{ id: 'm1', content: V4, authorId: 'u1', timestamp: new Date().toISOString(), type: 'message' }] as any[];
    const out = await decryptDMMessages('chan-x', msgs, true);
    expect(out[0].content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(out[0].undecryptable).toBe(true);
    expect(out[0]._encryptedEnvelope).toBe(V4);
  });

  it('decryptDMMessages stashes the reply ciphertext for the heal sweep', async () => {
    const msgs = [{
      id: 'm1', content: V4, authorId: 'u1', timestamp: new Date().toISOString(), type: 'message',
      replyTo: { id: 'm0', content: V4, authorId: 'u2' },
    }] as any[];
    const out = await decryptDMMessages('chan-x', msgs, true);
    expect(out[0].replyTo?.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(out[0].replyTo?._encryptedContent).toBe(V4);
  });

  it('decryptSingleDMMessage stamps the placeholder healable', async () => {
    const out = await decryptSingleDMMessage('chan-x', { id: 'm1', content: V4, authorId: 'u1', type: 'message' } as any);
    expect(out.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(out.undecryptable).toBe(true);
    expect(out._encryptedEnvelope).toBe(V4);
  });

  it('non-envelope content passes through untouched (plain system rows, legacy plaintext rows)', async () => {
    const out = await decryptDMContent('chan-x', 'plain text', false, 'u1');
    expect(out).toBe('plain text');
  });

  it('a v2/v3 legacy envelope renders the placeholder permanently (full teardown)', async () => {
    const v2 = JSON.stringify({ v: 2, iv: 'aXY=', ct: 'Y3Q=' });
    const out = await decryptDMContent('chan-x', v2, true, 'u1');
    expect(out).toBe(ENCRYPTED_PLACEHOLDER);
  });

  it('heals after classification: the same rows re-decrypt once isChannelMls flips true', async () => {
    // Step 1: rows arrive on an unclassified channel -> stamped healable.
    const msgs = [{
      id: 'm1', content: V4, authorId: 'u1', timestamp: new Date().toISOString(), type: 'message',
      replyTo: { id: 'm0', content: V4, authorId: 'u2' },
    }] as any[];
    const stamped = await decryptDMMessages('chan-x', msgs, true);
    expect(stamped[0].content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(stamped[0].undecryptable).toBe(true);
    expect(stamped[0]._encryptedEnvelope).toBe(V4);
    expect(stamped[0].replyTo?._encryptedContent).toBe(V4);

    // Step 2: the Welcome drain classifies the channel. Reconstruct exactly as
    // useMlsRedecrypt does (content <- _encryptedEnvelope; replyTo.content <-
    // _encryptedContent) and re-run the same funnel.
    mlsClassified = true;
    (mlsCoordinator.decrypt as any).mockResolvedValue('hello');
    const reconstructed: Message[] = stamped
      .filter((m) => m.undecryptable === true && typeof m._encryptedEnvelope === 'string')
      .map((m) => ({
        ...m,
        content: m._encryptedEnvelope as string,
        ...(m.replyTo?._encryptedContent
          ? { replyTo: { ...m.replyTo, content: m.replyTo._encryptedContent } }
          : {}),
      }));
    const healed = await decryptDMMessages('chan-x', reconstructed, true);
    expect(healed[0].content).toBe('hello');
    expect(healed[0].undecryptable).toBe(false);
    expect(healed[0]._encryptedEnvelope).toBeUndefined();
    expect(healed[0].replyTo?.content).toBe('hello');
  });
});
