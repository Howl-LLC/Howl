// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The SEND seam (encryptDMContent) routes MLS-classified 1:1 DM channels through
 * the MLS coordinator and fails closed (no downgrade).
 *
 * - A channel classified 'mls' (real encryptionFlags ratchet) encrypts via
 *   mlsCoordinator.encrypt and returns { content: <v4 envelope>, encrypted: true }.
 * - An 'mls' channel whose coordinator is not ready THROWS (no silent downgrade).
 * - An unclassified channel fails closed on encrypt: there is no legacy DM
 *   codec, so MLS is the only send path and there is no rung below it.
 *
 * mlsCoordinator + dmKeyManager are mocked; encryptionFlags is the REAL module
 * so setChannelProtocol / isChannelMls reflect the real one-way ratchet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/mls/mlsCoordinator', () => ({
  isReadyForChannel: vi.fn(() => false),
  encrypt: vi.fn(async () => JSON.stringify({ v: 4, m: 'bWxz' })),
  decrypt: vi.fn(async () => 'plaintext'),
  mlsEvents: { on: vi.fn(() => () => {}) },
}));

vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: vi.fn(() => true),
  isSetup: vi.fn(() => true),
  getChannelKey: vi.fn(() => new Uint8Array(32)),
  getChannelKeyEntries: vi.fn(() => [{ kid: 'k', key: new Uint8Array(32) }]),
  on: vi.fn(() => () => {}),
}));

import { encryptDMContent, initializeEncryption } from '../services/dmEncryption';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { setChannelProtocol, isChannelMls } from '../services/encryptionFlags';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  (mlsCoordinator.isReadyForChannel as any).mockReturnValue(false);
  initializeEncryption('alice');
});

describe('encryptDMContent — MLS send seam', () => {
  it('routes an mls-classified channel through mlsCoordinator.encrypt and returns a v4 envelope', async () => {
    setChannelProtocol('dm-mls', 'mls');
    expect(isChannelMls('dm-mls')).toBe(true);
    (mlsCoordinator.isReadyForChannel as any).mockReturnValue(true);

    const result = await encryptDMContent('dm-mls', 'hello there');

    expect(mlsCoordinator.encrypt).toHaveBeenCalledTimes(1);
    // The funnels now forward a trailing tier (default 'saved').
    expect(mlsCoordinator.encrypt).toHaveBeenCalledWith('dm-mls', 'hello there', 'saved');
    expect(result.encrypted).toBe(true);
    const env = JSON.parse(result.content);
    expect(env.v).toBe(4);
    expect(typeof env.m).toBe('string');
  });

  it('throws (fail closed) when an mls channel is not ready — never downgrades to legacy', async () => {
    setChannelProtocol('dm-mls-notready', 'mls');
    (mlsCoordinator.isReadyForChannel as any).mockReturnValue(false);

    await expect(encryptDMContent('dm-mls-notready', 'secret')).rejects.toThrow(/unlock encryption/i);

    expect(mlsCoordinator.encrypt).not.toHaveBeenCalled();
  });

  it('fails closed for an unclassified channel (no legacy AES path)', async () => {
    expect(isChannelMls('dm-legacy')).toBe(false);

    await expect(encryptDMContent('dm-legacy', 'legacy message')).rejects.toThrow(/unlock encryption/i);

    expect(mlsCoordinator.encrypt).not.toHaveBeenCalled();
  });
});
