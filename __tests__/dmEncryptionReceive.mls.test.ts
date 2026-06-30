// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The RECEIVE seams route MLS-classified channels through mlsCoordinator.decrypt
 * and fail closed to ENCRYPTED_PLACEHOLDER. Covers all three decrypt funnels:
 * decryptDMContent, decryptDMMessages, decryptSingleDMMessage.
 *
 * On an mls channel:
 *   - a v4 envelope -> mlsCoordinator.decrypt.
 *   - an anomalous v2/v3 envelope (or any non-v4 content) -> ENCRYPTED_PLACEHOLDER.
 *   - a v4 envelope whose decrypt throws -> ENCRYPTED_PLACEHOLDER (never drops).
 *
 * On an unclassified channel: there is no legacy DM codec, so MLS is the only
 * decrypt path. Envelope-shaped rows are stamped with the healable placeholder
 * (undecryptable + preserved ciphertext) for the useMlsRedecrypt sweep to recover
 * once the channel classifies 'mls'.
 *
 * mlsCoordinator + dmKeyManager are mocked; encryptionFlags is the REAL module so
 * the 'mls' ratchet is exercised end to end.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Message } from '../types';

vi.mock('../services/mls/mlsCoordinator', () => ({
  isReadyForChannel: vi.fn(() => true),
  encrypt: vi.fn(async () => JSON.stringify({ v: 4, m: 'bWxz' })),
  decrypt: vi.fn(async () => 'decrypted mls plaintext'),
  mlsEvents: { on: vi.fn(() => () => {}) },
}));

vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: vi.fn(() => true),
  isSetup: vi.fn(() => true),
  getChannelKey: vi.fn(() => new Uint8Array(32)),
  getChannelKeyEntries: vi.fn(() => [{ kid: 'k', key: new Uint8Array(32) }]),
  on: vi.fn(() => () => {}),
}));

import {
  decryptDMContent,
  decryptDMMessages,
  decryptSingleDMMessage,
  ENCRYPTED_PLACEHOLDER,
  initializeEncryption,
} from '../services/dmEncryption';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { setChannelProtocol, isChannelMls } from '../services/encryptionFlags';

const V4 = JSON.stringify({ v: 4, m: 'bWxzLW1lc3NhZ2U=' });
const V3 = JSON.stringify({ v: 3, iv: 'aXY=', ct: 'Y3Q=', mid: 'm1' });

function mkMsg(content: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    content,
    authorId: 'bob',
    type: 'text',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Message;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  (mlsCoordinator.decrypt as any).mockResolvedValue('decrypted mls plaintext');
  initializeEncryption('alice');
});

// decryptDMContent
describe('decryptDMContent — MLS receive seam', () => {
  it('routes a v4 envelope on an mls channel through mlsCoordinator.decrypt', async () => {
    setChannelProtocol('dm-mls', 'mls');
    expect(isChannelMls('dm-mls')).toBe(true);

    const out = await decryptDMContent('dm-mls', V4, true, 'bob');

    expect(mlsCoordinator.decrypt).toHaveBeenCalledTimes(1);
    // decryptDMContent now forwards an optional messageId (undefined here — this
    // scalar funnel call passed none) and a trailing tier (default 'saved');
    // the v4 envelope still routes to the coordinator.
    expect(mlsCoordinator.decrypt).toHaveBeenCalledWith('dm-mls', V4, undefined, 'saved');
    expect(out).toBe('decrypted mls plaintext');
  });

  it('returns placeholder for an anomalous v3 envelope on an mls channel — no legacy fallback', async () => {
    setChannelProtocol('dm-mls', 'mls');

    const out = await decryptDMContent('dm-mls', V3, true, 'bob');

    expect(out).toBe(ENCRYPTED_PLACEHOLDER);
    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
  });

  it('returns placeholder when mls decrypt throws (never drops)', async () => {
    setChannelProtocol('dm-mls', 'mls');
    (mlsCoordinator.decrypt as any).mockRejectedValue(new Error('boom'));

    const out = await decryptDMContent('dm-mls', V4, true, 'bob');

    expect(out).toBe(ENCRYPTED_PLACEHOLDER);
  });

  it('placeholders an envelope on a non-mls channel (no legacy path)', async () => {
    const out = await decryptDMContent('dm-legacy', V3, true, 'bob');

    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
    expect(out).toBe(ENCRYPTED_PLACEHOLDER);
  });
});

// decryptDMMessages (batch)
describe('decryptDMMessages — MLS receive seam', () => {
  it('routes a v4 message + v4 reply through mlsCoordinator.decrypt on an mls channel', async () => {
    setChannelProtocol('dm-mls', 'mls');
    const msgs: Message[] = [
      mkMsg(V4, { id: 'm-a', replyTo: { content: V4, authorId: 'carol' } as any }),
    ];

    const out = await decryptDMMessages('dm-mls', msgs, true);

    expect(out[0].content).toBe('decrypted mls plaintext');
    expect((out[0].replyTo as any).content).toBe('decrypted mls plaintext');
  });

  it('placeholders an anomalous v3 message on an mls channel without legacy decrypt', async () => {
    setChannelProtocol('dm-mls', 'mls');
    const msgs: Message[] = [mkMsg(V3, { id: 'm-b' })];

    const out = await decryptDMMessages('dm-mls', msgs, true);

    expect(out[0].content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
  });

  it('placeholders a v4 message when mls decrypt throws (never drops)', async () => {
    setChannelProtocol('dm-mls', 'mls');
    (mlsCoordinator.decrypt as any).mockRejectedValue(new Error('boom'));
    const msgs: Message[] = [mkMsg(V4, { id: 'm-c' })];

    const out = await decryptDMMessages('dm-mls', msgs, true);

    expect(out[0].content).toBe(ENCRYPTED_PLACEHOLDER);
  });

  it('passes system messages through untouched on an mls channel', async () => {
    setChannelProtocol('dm-mls', 'mls');
    const msgs: Message[] = [mkMsg('joined', { id: 'm-sys', type: 'system' })];

    const out = await decryptDMMessages('dm-mls', msgs, true);

    expect(out[0].content).toBe('joined');
    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
  });

  it('stamps an envelope healable on a non-mls channel (no legacy path)', async () => {
    const msgs: Message[] = [mkMsg(V3, { id: 'm-d' })];

    const out = await decryptDMMessages('dm-legacy', msgs, true);

    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
    expect(out[0].content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(out[0].undecryptable).toBe(true);
    expect(out[0]._encryptedEnvelope).toBe(V3);
  });
});

// decryptDMMessages — undecryptable flag + envelope + oldest-first
describe('decryptDMMessages — flags + oldest-first', () => {
  it('decryptDMMessages stamps undecryptable + preserves envelope per message, passes msg.id', async () => {
    setChannelProtocol('dm-mls', 'mls');
    (mlsCoordinator.decrypt as Mock).mockImplementation(async (_ch, env) => {
      if (env === V4) return 'ok';
      throw new Error('nope');
    });
    const out = await decryptDMMessages('dm-mls', [
      mkMsg(V4, { id: 'good' }),
      mkMsg('not-an-envelope', { id: 'bad' }),
    ], true);
    const good = out.find((m) => m.id === 'good')!;
    const bad = out.find((m) => m.id === 'bad')!;
    expect(good.content).toBe('ok');
    expect(good.undecryptable).toBe(false);
    expect(bad.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(bad.undecryptable).toBe(true);
    expect(bad._encryptedEnvelope).toBe('not-an-envelope');
    expect(mlsCoordinator.decrypt).toHaveBeenCalledWith('dm-mls', V4, 'good', 'saved');
  });

  it('decryptDMMessages decrypts oldest-first regardless of input order', async () => {
    setChannelProtocol('dm-mls', 'mls');
    const order: string[] = [];
    (mlsCoordinator.decrypt as Mock).mockImplementation(async (_ch, env) => { order.push(env); return env; });
    // Three DISTINCT real v4 envelopes (the real isMlsEnvelopeV4 is in force here,
    // so `V4 + '#n'` would not parse as v4 and never reach the coordinator).
    const env1 = JSON.stringify({ v: 4, m: btoa('one') });
    const env2 = JSON.stringify({ v: 4, m: btoa('two') });
    const env3 = JSON.stringify({ v: 4, m: btoa('three') });
    // input newest-first; Message.timestamp is a Date, ascending by suffix.
    const t = (n: number) => new Date(2020, 0, 1, 0, 0, n);
    await decryptDMMessages('dm-mls', [
      mkMsg(env3, { id: 'c', timestamp: t(3) }),
      mkMsg(env1, { id: 'a', timestamp: t(1) }),
      mkMsg(env2, { id: 'b', timestamp: t(2) }),
    ], true);
    expect(order).toEqual([env1, env2, env3]);
  });
});

// decryptSingleDMMessage
describe('decryptSingleDMMessage — MLS receive seam', () => {
  it('routes a v4 message through mlsCoordinator.decrypt on an mls channel', async () => {
    setChannelProtocol('dm-mls', 'mls');

    const out = await decryptSingleDMMessage('dm-mls', mkMsg(V4));

    expect(out.content).toBe('decrypted mls plaintext');
    expect(mlsCoordinator.decrypt).toHaveBeenCalledTimes(1);
  });

  it('placeholders an anomalous v3 message on an mls channel without legacy decrypt', async () => {
    setChannelProtocol('dm-mls', 'mls');

    const out = await decryptSingleDMMessage('dm-mls', mkMsg(V3));

    expect(out.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
  });

  it('placeholders a v4 message when mls decrypt throws', async () => {
    setChannelProtocol('dm-mls', 'mls');
    (mlsCoordinator.decrypt as any).mockRejectedValue(new Error('boom'));

    const out = await decryptSingleDMMessage('dm-mls', mkMsg(V4));

    expect(out.content).toBe(ENCRYPTED_PLACEHOLDER);
  });

  it('passes a system message through untouched on an mls channel', async () => {
    setChannelProtocol('dm-mls', 'mls');

    const out = await decryptSingleDMMessage('dm-mls', mkMsg('sys', { type: 'system' }));

    expect(out.content).toBe('sys');
    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
  });

  it('stamps an envelope healable on a non-mls channel (no legacy path)', async () => {
    const out = await decryptSingleDMMessage('dm-legacy', mkMsg(V3));

    expect(mlsCoordinator.decrypt).not.toHaveBeenCalled();
    expect(out.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(out.undecryptable).toBe(true);
    expect(out._encryptedEnvelope).toBe(V3);
  });
});

// decryptSingleDMMessage — undecryptable flag + envelope
describe('decryptSingleDMMessage — undecryptable + _encryptedEnvelope', () => {
  it('decryptSingleDMMessage stamps undecryptable + preserves the envelope on failure', async () => {
    setChannelProtocol('dm-mls', 'mls');
    // V4 is a v4 envelope; make the coordinator throw to simulate not-ready
    (mlsCoordinator.decrypt as Mock).mockRejectedValueOnce(new Error('not ready'));
    const out = await decryptSingleDMMessage('dm-mls', mkMsg(V4, { id: 'm1' }));
    expect(out.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(out.undecryptable).toBe(true);
    expect(out._encryptedEnvelope).toBe(V4);
  });

  it('decryptSingleDMMessage clears the flag on success and passes messageId', async () => {
    setChannelProtocol('dm-mls', 'mls');
    (mlsCoordinator.decrypt as Mock).mockResolvedValueOnce('hello');
    const out = await decryptSingleDMMessage('dm-mls', mkMsg(V4, { id: 'm2' }));
    expect(out.content).toBe('hello');
    expect(out.undecryptable).toBe(false);
    expect(out._encryptedEnvelope).toBeUndefined();
    expect(mlsCoordinator.decrypt).toHaveBeenCalledWith('dm-mls', V4, 'm2', 'saved');
  });
});
