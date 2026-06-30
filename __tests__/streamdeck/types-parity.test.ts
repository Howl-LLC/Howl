// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { OFFICIAL_PLUGIN_ID as TS_OFFICIAL, SUPPORTED_PROTOCOL_VERSIONS as TS_VERS, MAX_FRAME_BYTES as TS_MAX } from '../../shared/streamdeck/types';

const JS = await import('../../electron/streamdeck/schemas.js').then((m) => m.default ?? m);

describe('streamdeck/types parity', () => {
  it('official plugin id matches', () => {
    expect(TS_OFFICIAL).toBe(JS.OFFICIAL_PLUGIN_ID);
  });
  it('supported protocol versions match', () => {
    expect([...TS_VERS]).toEqual(JS.SUPPORTED_PROTOCOL_VERSIONS);
  });
  it('max frame bytes matches', () => {
    expect(TS_MAX).toBe(JS.MAX_FRAME_BYTES);
  });
});
