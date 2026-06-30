// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { bucketProtocolSockets, type ProtocolSocketLike } from '../src/queues/workers/analytics.worker.js';

function mkSocket(buildDate: string | null, protocolVersion: number | null, ua: string): ProtocolSocketLike {
  return {
    data: { protocolContext: { buildDate, protocolVersion } },
    handshake: { headers: { 'user-agent': ua } },
  };
}

describe('bucketProtocolSockets', () => {
  it('groups a single socket correctly', () => {
    const sockets = [mkSocket('2026-04-19', 1, 'Mozilla/5.0 Chrome/120')];
    const result = bucketProtocolSockets(sockets);
    expect(result).toEqual([
      { buildDate: '2026-04-19', platform: 'web', protocolVersion: 1, count: 1 },
    ]);
  });

  it('detects electron from User-Agent', () => {
    const sockets = [mkSocket('2026-04-19', 1, 'Mozilla/5.0 Electron/30.0 Chrome/120')];
    const result = bucketProtocolSockets(sockets);
    expect(result[0].platform).toBe('electron');
  });

  it('classifies missing user-agent as unknown', () => {
    const sockets = [mkSocket('2026-04-19', 1, '')];
    const result = bucketProtocolSockets(sockets);
    expect(result[0].platform).toBe('unknown');
  });

  it('null buildDate and null protocolVersion remain null in output', () => {
    const sockets = [mkSocket(null, null, 'Chrome')];
    const result = bucketProtocolSockets(sockets);
    expect(result).toEqual([
      { buildDate: null, platform: 'web', protocolVersion: null, count: 1 },
    ]);
  });

  it('groups multiple sockets with same key into one bucket', () => {
    const sockets = [
      mkSocket('2026-04-19', 1, 'Chrome'),
      mkSocket('2026-04-19', 1, 'Chrome'),
      mkSocket('2026-04-19', 1, 'Chrome'),
    ];
    const result = bucketProtocolSockets(sockets);
    expect(result).toEqual([
      { buildDate: '2026-04-19', platform: 'web', protocolVersion: 1, count: 3 },
    ]);
  });

  it('splits different platforms into separate buckets', () => {
    const sockets = [
      mkSocket('2026-04-19', 1, 'Chrome'),
      mkSocket('2026-04-19', 1, 'Electron/30.0'),
    ];
    const result = bucketProtocolSockets(sockets);
    expect(result).toHaveLength(2);
    const web = result.find(r => r.platform === 'web');
    const electron = result.find(r => r.platform === 'electron');
    expect(web?.count).toBe(1);
    expect(electron?.count).toBe(1);
  });

  it('empty socket list returns empty array', () => {
    expect(bucketProtocolSockets([])).toEqual([]);
  });
});
