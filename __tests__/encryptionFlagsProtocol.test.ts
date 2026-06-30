// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * encryptionFlags protocol classification.
 * There is only one protocol ('mls'):
 * - setChannelProtocol records 'mls' and is idempotent.
 * - getChannelProtocol returns null for unknown channels.
 * - Cross-tab `storage` events merge 'mls' in (merge-only).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setChannelProtocol,
  getChannelProtocol,
  isChannelMls,
} from '../services/encryptionFlags';

const PROTO_KEY = 'howl_channel_protocol';

beforeEach(() => {
  localStorage.clear();
});

describe('encryptionFlags channel protocol classification', () => {
  it('returns null for an unknown channel', () => {
    expect(getChannelProtocol('chan-unknown')).toBeNull();
    expect(isChannelMls('chan-unknown')).toBe(false);
  });

  it('classifies a channel mls and reports it', () => {
    setChannelProtocol('chan-1', 'mls');
    expect(getChannelProtocol('chan-1')).toBe('mls');
    expect(isChannelMls('chan-1')).toBe(true);
  });

  it('is idempotent on a repeated mls classification', () => {
    setChannelProtocol('chan-2', 'mls');
    setChannelProtocol('chan-2', 'mls');
    expect(getChannelProtocol('chan-2')).toBe('mls');
    expect(isChannelMls('chan-2')).toBe(true);
  });

  it('merges mls in from a sibling-tab storage event', () => {
    setChannelProtocol('chan-4', 'mls');
    // Simulate a sibling tab writing a payload that adds chan-5 as mls.
    const siblingPayload = JSON.stringify([['chan-4', 'mls'], ['chan-5', 'mls']]);
    window.dispatchEvent(new StorageEvent('storage', { key: PROTO_KEY, newValue: siblingPayload }));
    expect(getChannelProtocol('chan-4')).toBe('mls');
    expect(getChannelProtocol('chan-5')).toBe('mls'); // merged in
  });
});
