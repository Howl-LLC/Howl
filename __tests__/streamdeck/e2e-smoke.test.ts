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

const bridgeServer = require_('../../electron/streamdeck/bridge-server.js');

let tmpDir: string;
let srv: any;
let port: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'howl-sde2e-'));
  // Re-inject mock before each test (in case token-store state drifted)
  tokenStoreMod._setSafeStorage(mockSafeStorage);
  srv = await bridgeServer.start({
    userDataDir: tmpDir,
    installId: 'install-e2e',
    appVersion: '1.0.3',
    onPairRequest: async () => ({ decision: 'allow' }),
    onExecute: async () => ({ code: 'not-implemented' }),
    onListResource: async () => ({ data: [] }),
    onSubscribe: async () => [],
  });
  port = srv.port;
});

afterEach(async () => {
  await srv?.stop();
});

function open() {
  return new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { Host: `127.0.0.1:${port}` },
  });
}

async function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((r) => ws.once('open', () => r()));
}

// Queue-aware recv: attach a single permanent listener and buffer messages
// so callers can recv() multiple frames without losing any that arrive
// between calls (e.g. pair-challenge-ack then pair-accepted).
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
  const w = (ws as unknown as { _howlRecv?: () => Promise<any> });
  if (!w._howlRecv) w._howlRecv = makeRecv(ws);
  return w._howlRecv();
}

describe('streamdeck/e2e — full pair → auth → subscribe → execute cycle', () => {
  it('completes the handshake stubbed-executor cycle', async () => {
    // Step 1: Pair
    const ws = open();
    await waitOpen(ws);

    ws.send(JSON.stringify({
      v: 1, id: '11111111-2222-3333-4444-555555555555', kind: 'command', type: 'pair',
      pluginId: 'com.howlpro.streamdeck', displayName: 'E2E', version: '1.0.0', challenge: 'a'.repeat(64),
    }));
    const pairResp = await recv(ws);
    expect(pairResp.kind).toBe('response');
    expect(pairResp.type).toBe('pair-accepted');
    expect(typeof pairResp.data.token).toBe('string');
    const token = pairResp.data.token;
    ws.close();

    // Step 2: Auth on a fresh connection
    const ws2 = open();
    await waitOpen(ws2);

    ws2.send(JSON.stringify({
      v: 1, id: '22222222-2222-3333-4444-555555555555', kind: 'command', type: 'auth', token,
    }));
    const authResp = await recv(ws2);
    expect(authResp.kind).toBe('response');
    expect(authResp.type).toBe('auth-ok');
    expect(authResp.data.pluginId).toBe('com.howlpro.streamdeck');

    // Step 3: Subscribe
    ws2.send(JSON.stringify({
      v: 1, id: '33333333-2222-3333-4444-555555555555', kind: 'command', type: 'subscribe',
      topics: ['state.voice', 'state.bridge'],
    }));
    const subResp = await recv(ws2);
    expect(subResp.kind).toBe('response');
    expect(subResp.type).toBe('subscribed');

    // Step 4: Execute (stub returns not-implemented)
    ws2.send(JSON.stringify({
      v: 1, id: '44444444-2222-3333-4444-555555555555', kind: 'command', type: 'execute',
      action: 'voice.mute', params: {},
    }));
    const exeResp = await recv(ws2);
    expect(exeResp.kind).toBe('error');
    expect(exeResp.code).toBe('not-implemented');

    ws2.close();
  });
});
