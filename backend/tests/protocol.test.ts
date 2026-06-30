// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { parseProtocolContext } from '../src/protocol.js';

describe('parseProtocolContext', () => {
  it('parses a valid full context', () => {
    expect(parseProtocolContext({ buildDate: '2026-04-19', protocolVersion: 1, capabilities: ['sframe.v1'] }))
      .toEqual({ buildDate: '2026-04-19', protocolVersion: 1, capabilities: ['sframe.v1'] });
  });

  it('accepts string protocolVersion', () => {
    expect(parseProtocolContext({ buildDate: '2026-04-19', protocolVersion: '2', capabilities: [] }).protocolVersion).toBe(2);
  });

  it('rejects protocolVersion=0 on both numeric and string paths', () => {
    expect(parseProtocolContext({ buildDate: null, protocolVersion: 0, capabilities: [] }).protocolVersion).toBeNull();
    expect(parseProtocolContext({ buildDate: null, protocolVersion: '0', capabilities: [] }).protocolVersion).toBeNull();
  });

  it('rejects non-ISO-date buildDate', () => {
    expect(parseProtocolContext({ buildDate: 'not-a-date', protocolVersion: 1, capabilities: [] }).buildDate).toBeNull();
    expect(parseProtocolContext({ buildDate: 12345, protocolVersion: 1, capabilities: [] }).buildDate).toBeNull();
  });

  it('rejects non-array capabilities', () => {
    expect(parseProtocolContext({ buildDate: null, protocolVersion: 1, capabilities: 'sframe.v1' }).capabilities).toEqual([]);
    expect(parseProtocolContext({ buildDate: null, protocolVersion: 1, capabilities: [1, 2, 3] }).capabilities).toEqual([]);
  });

  it('returns all null/empty on an empty input', () => {
    expect(parseProtocolContext({ buildDate: undefined, protocolVersion: undefined, capabilities: undefined }))
      .toEqual({ buildDate: null, protocolVersion: null, capabilities: [] });
  });
});
