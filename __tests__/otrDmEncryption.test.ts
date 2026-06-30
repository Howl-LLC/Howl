// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * OTR: the dmEncryption funnels thread an optional `tier` through to the MLS
 * coordinator. The bare dmChannelId is still mls-classified regardless of tier
 * (isChannelMls is keyed on the bare id); only the coordinator call carries the
 * tier.
 *
 * - encryptDMContent(id, plaintext, channel?, tier) forwards tier to
 *   isReadyForChannel + encrypt.
 * - decryptDMContent / decryptSingleDMMessage forward tier to decrypt.
 * - The default-tier path (no tier arg) calls the coordinator with 'saved'.
 *
 * mlsCoordinator + dmKeyManager are mocked; encryptionFlags is the REAL module
 * so the 'mls' ratchet classification is exercised.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  encryptDMContent,
  decryptDMContent,
  decryptSingleDMMessage,
  initializeEncryption,
} from '../services/dmEncryption';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { setChannelProtocol, isChannelMls } from '../services/encryptionFlags';

const V4 = JSON.stringify({ v: 4, m: 'bWxzLW1lc3NhZ2U=' });

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
  (mlsCoordinator.isReadyForChannel as any).mockReturnValue(true);
  (mlsCoordinator.decrypt as any).mockResolvedValue('decrypted mls plaintext');
  initializeEncryption('alice');
});

describe('dmEncryption — tier threading (OTR)', () => {
  it('encryptDMContent forwards tier=otr to isReadyForChannel + encrypt', async () => {
    setChannelProtocol('dm-mls', 'mls');
    expect(isChannelMls('dm-mls')).toBe(true);

    await encryptDMContent('dm-mls', 'x', undefined, 'otr');

    expect(mlsCoordinator.isReadyForChannel).toHaveBeenCalledWith('dm-mls', 'otr');
    expect(mlsCoordinator.encrypt).toHaveBeenCalledWith('dm-mls', 'x', 'otr');
  });

  it('decryptDMContent forwards tier=otr to mlsCoordinator.decrypt', async () => {
    setChannelProtocol('dm-mls', 'mls');

    await decryptDMContent('dm-mls', V4, true, 'bob', 'm9', 'otr');

    expect(mlsCoordinator.decrypt).toHaveBeenCalledWith('dm-mls', V4, 'm9', 'otr');
  });

  it('decryptSingleDMMessage forwards tier=otr (with msg.id) to mlsCoordinator.decrypt', async () => {
    setChannelProtocol('dm-mls', 'mls');

    await decryptSingleDMMessage('dm-mls', mkMsg(V4, { id: 'm7' }), undefined, 'otr');

    expect(mlsCoordinator.decrypt).toHaveBeenCalledWith('dm-mls', V4, 'm7', 'otr');
  });

  it('defaults to tier=saved when no tier is passed (regression)', async () => {
    setChannelProtocol('dm-mls', 'mls');

    await encryptDMContent('dm-mls', 'y');
    await decryptSingleDMMessage('dm-mls', mkMsg(V4, { id: 'm5' }));

    expect(mlsCoordinator.isReadyForChannel).toHaveBeenCalledWith('dm-mls', 'saved');
    expect(mlsCoordinator.encrypt).toHaveBeenCalledWith('dm-mls', 'y', 'saved');
    expect(mlsCoordinator.decrypt).toHaveBeenCalledWith('dm-mls', V4, 'm5', 'saved');
  });
});
