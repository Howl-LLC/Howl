// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
// Use dynamic import because the file is CJS
const schemas = await import('../../electron/streamdeck/schemas.js').then((m) => m.default ?? m);

describe('streamdeck/schemas — pairRequest', () => {
  it('accepts a valid pair request', () => {
    const r = schemas.pairRequestSchema.safeParse({
      v: 1,
      id: '11111111-2222-3333-4444-555555555555',
      kind: 'command',
      type: 'pair',
      pluginId: 'com.howlpro.streamdeck',
      displayName: 'Howl Stream Deck',
      version: '1.0.0',
      challenge: 'a'.repeat(64),
    });
    expect(r.success).toBe(true);
  });

  it('rejects pluginId that is not reverse-DNS', () => {
    const r = schemas.pairRequestSchema.safeParse({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'HOWL!!!', displayName: 'X', version: '1.0.0', challenge: 'a'.repeat(64),
    });
    expect(r.success).toBe(false);
  });

  it('rejects displayName over 64 chars', () => {
    const r = schemas.pairRequestSchema.safeParse({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'x'.repeat(65), version: '1.0.0', challenge: 'a'.repeat(64),
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields in strict mode', () => {
    const r = schemas.pairRequestSchema.safeParse({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'X', version: '1.0.0', challenge: 'a'.repeat(64),
      extra: 'evil',
    });
    expect(r.success).toBe(false);
  });
});

describe('streamdeck/schemas — auth', () => {
  it('accepts valid auth', () => {
    const r = schemas.authSchema.safeParse({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'auth',
      token: 'A'.repeat(88),
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing token', () => {
    const r = schemas.authSchema.safeParse({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'auth',
    });
    expect(r.success).toBe(false);
  });
});

describe('streamdeck/schemas — protocol version', () => {
  it('rejects v=2 (not supported in P1)', () => {
    const r = schemas.pairRequestSchema.safeParse({
      v: 2, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'X', version: '1.0.0', challenge: 'a'.repeat(64),
    });
    expect(r.success).toBe(false);
  });
});
