// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { getProtocolHeaders } from '../services/api/protocolHeaders';
import { CURRENT_PROTOCOL_VERSION, KNOWN_CAPABILITIES } from '../shared/protocol';

describe('getProtocolHeaders', () => {
  it('returns the three expected protocol header keys', async () => {
    const headers = await getProtocolHeaders();
    expect(headers).toHaveProperty('X-Client-Build-Date');
    expect(headers).toHaveProperty('X-Protocol-Version');
    expect(headers).toHaveProperty('X-Client-Capabilities');
    expect(Object.keys(headers)).toHaveLength(3);
  });

  it('returns X-Client-Build-Date as an ISO date string (YYYY-MM-DD)', async () => {
    const headers = await getProtocolHeaders();
    expect(headers['X-Client-Build-Date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns X-Protocol-Version matching CURRENT_PROTOCOL_VERSION', async () => {
    const headers = await getProtocolHeaders();
    expect(headers['X-Protocol-Version']).toBe(String(CURRENT_PROTOCOL_VERSION));
  });

  it('returns X-Client-Capabilities as a comma-joined list of KNOWN_CAPABILITIES', async () => {
    const headers = await getProtocolHeaders();
    expect(headers['X-Client-Capabilities']).toBe(KNOWN_CAPABILITIES.join(','));
  });

  it('returns the same shape that APIClient.request() would set inline', async () => {
    // This test validates that the extracted helper produces the exact same
    // header object that the inline block in request() used to build.
    // The canonical shape is: { 'X-Client-Build-Date': <iso>, 'X-Protocol-Version': <string int>, 'X-Client-Capabilities': <csv> }
    const headers = await getProtocolHeaders();
    expect(typeof headers['X-Client-Build-Date']).toBe('string');
    expect(Number(headers['X-Protocol-Version'])).toBe(CURRENT_PROTOCOL_VERSION);
    expect(headers['X-Client-Capabilities'].split(',')).toEqual([...KNOWN_CAPABILITIES]);
  });
});
