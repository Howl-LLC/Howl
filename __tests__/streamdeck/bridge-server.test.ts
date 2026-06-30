// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';

// vi.mock('electron') as defense-in-depth — but the real fix is _setSafeStorage below
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (s: string) => Buffer.from('ENC:' + s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC:/, ''),
  },
}));

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: (s: string) => Buffer.from('ENC:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC:/, ''),
};

// Use createRequire so we get the exact same CJS module instances that
// bridge-server.js will get when it require()s token-store.js.
const require_ = createRequire(import.meta.url);
const tokenStoreMod = require_('../../electron/streamdeck/token-store.js');
tokenStoreMod._setSafeStorage(mockSafeStorage);

const mod = require_('../../electron/streamdeck/bridge-server.js');

let tmpDir: string;
let srv: any;
let port: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'howl-sdbr-'));
  // Re-inject mock before each test (in case token-store state drifted)
  tokenStoreMod._setSafeStorage(mockSafeStorage);
  srv = await mod.start({
    userDataDir: tmpDir,
    installId: 'install-xyz',
    appVersion: '1.0.3',
    onPairRequest: async (_info: any) => ({ decision: 'allow' }),
    onExecute: async () => ({ code: 'not-implemented' }),
    onListResource: async () => ({ data: [] }),
  });
  port = srv.port;
});

afterEach(async () => {
  await srv?.stop();
});

function open(headers: Record<string, string> = {}) {
  return new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { Host: `127.0.0.1:${port}`, ...headers },
  });
}

async function send(ws: WebSocket, payload: unknown) {
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.send(JSON.stringify(payload));
}

// Queue-aware recv: attach a single permanent listener and buffer messages
// so that callers can recv() multiple frames in a row without losing any
// that arrive between calls (e.g. pair-challenge-ack then pair-accepted).
function makeRecv(ws: WebSocket): () => Promise<any> {
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (waiters.length > 0) waiters.shift()!(m);
    else queue.push(m);
  });
  return () => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise<any>((r) => waiters.push(r));
  };
}

async function recv(ws: WebSocket): Promise<any> {
  // For tests that don't bind a queue up-front. Single-frame responses
  // still work as before.
  const w = (ws as unknown as { _howlRecv?: () => Promise<any> });
  if (!w._howlRecv) w._howlRecv = makeRecv(ws);
  return w._howlRecv();
}

describe('streamdeck/bridge-server — hardening', () => {
  it('binds loopback only', () => {
    expect(srv.address).toBe('127.0.0.1');
  });

  it('rejects upgrade with non-loopback Host header (DNS rebinding)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Host: 'evil.com' },
    });
    const err = await new Promise<Error>((r) => ws.once('error', r));
    expect(err).toBeDefined();
  });

  it('rejects upgrade with Origin header set', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.com' },
    });
    const err = await new Promise<Error>((r) => ws.once('error', r));
    expect(err).toBeDefined();
  });

  it('closes connection that sends malformed JSON 3 times', async () => {
    const ws = open();
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send('not json');
    ws.send('still not');
    ws.send('nope');
    const closed = await new Promise<number>((r) => ws.once('close', (code) => r(code)));
    expect(closed).toBeGreaterThanOrEqual(1000);
  });

  it('pair flow end-to-end: pair → token issued → auth succeeds', async () => {
    const ws = open();
    await send(ws, {
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'Howl', version: '1.0.0', challenge: 'a'.repeat(64),
    });
    const resp: any = await recv(ws);
    expect(resp.kind).toBe('response');
    expect(resp.type).toBe('pair-accepted');
    expect(typeof resp.data.token).toBe('string');

    ws.close();

    const ws2 = open();
    await send(ws2, {
      v: 1, id: '22222222-2222-3333-4444-555555555555', kind: 'command', type: 'auth',
      token: resp.data.token,
    });
    const authResp: any = await recv(ws2);
    expect(authResp.kind).toBe('response');
    expect(authResp.type).toBe('auth-ok');
    ws2.close();
  });

  it('returns unsupported-version for v=2', async () => {
    const ws = open();
    await send(ws, { v: 2, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'auth', token: 'x' });
    const r: any = await recv(ws);
    expect(r.kind).toBe('error');
    expect(r.code).toBe('unsupported-version');
  });

  it('rate-limits pair requests (4th in 5 min is rejected)', async () => {
    const mkPair = (id: string) => ({
      v: 1, id, kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'Howl', version: '1.0.0', challenge: 'a'.repeat(64),
    });
    const uuids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ];
    for (let i = 0; i < 3; i++) {
      const ws = open();
      await send(ws, mkPair(uuids[i]));
      await recv(ws);
      ws.close();
    }
    const ws4 = open();
    await send(ws4, mkPair(uuids[3]));
    const r: any = await recv(ws4);
    expect(r.kind).toBe('error');
    expect(r.code).toBe('pair-rate-limited');
    ws4.close();
  });

  it('frame larger than MAX_FRAME_BYTES is rejected', async () => {
    const ws = open();
    await new Promise<void>((r) => ws.once('open', () => r()));
    const bigStr = 'x'.repeat(200 * 1024);
    ws.send(JSON.stringify({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'Howl', version: '1.0.0', challenge: bigStr,
    }));
    const r: any = await recv(ws);
    expect(r.kind).toBe('error');
    expect(r.code === 'schema' || r.code === 'frame-too-large').toBe(true);
  });
});
