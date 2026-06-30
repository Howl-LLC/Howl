// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { roomKey, isOtrRoomKey, bareChannelId } from '../services/mls/roomKey';

describe('roomKey', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  it('saved tier is identity (zero-migration property)', () => {
    expect(roomKey(id, 'saved')).toBe(id);
  });
  it('otr tier namespaces with #otr suffix', () => {
    expect(roomKey(id, 'otr')).toBe(`${id}#otr`);
  });
  it('isOtrRoomKey distinguishes the two', () => {
    expect(isOtrRoomKey(roomKey(id, 'otr'))).toBe(true);
    expect(isOtrRoomKey(roomKey(id, 'saved'))).toBe(false);
  });
});

describe('bareChannelId', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  it('strips the #otr suffix from an OTR room key', () => {
    expect(bareChannelId(roomKey(id, 'otr'))).toBe(id);
  });
  it('is identity on a bare (Saved) channel id', () => {
    expect(bareChannelId(roomKey(id, 'saved'))).toBe(id);
    expect(bareChannelId(id)).toBe(id);
  });
});
