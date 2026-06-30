// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Version-gate enforcement integration tests.
 *
 * Exercises the full socket handshake → must-update → disconnect pipeline
 * and the REST enforceVersionGateHttp middleware on /livekit, verifying both
 * the enforcing (ENFORCE_VERSION_GATE=true) and permissive (default) modes.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { httpServer } from '../src/server.js';
import { createTestUser, cleanupTestData, type TestUser } from './helpers.js';
import { mockHandshakeAsOldClient, mockHandshakeAsExpiredClient } from './versionGateHelpers.js';
import { COMPAT_WINDOW_DAYS, SOFT_WARNING_DAYS, CURRENT_PROTOCOL_VERSION, KNOWN_CAPABILITIES } from '../src/protocol.js';
import type { AddressInfo } from 'net';

let baseUrl: string;
let app: typeof httpServer;
const clients: ClientSocket[] = [];

/** Track sockets for cleanup. */
function track(socket: ClientSocket): ClientSocket {
  clients.push(socket);
  return socket;
}

/** Connect with arbitrary auth fields. */
function connectSocketWithAuth(auth: Record<string, unknown>): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      auth,
      forceNew: true,
      reconnection: false,
    });
    track(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
  });
}

/** Build an ISO date string (YYYY-MM-DD) N days ago. */
function buildDateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });
  const addr = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  app = httpServer;
});

afterEach(() => {
  for (const c of clients) {
    if (c.connected) c.disconnect();
  }
  clients.length = 0;
});

afterAll(async () => {
  delete process.env.ENFORCE_VERSION_GATE;
  await cleanupTestData();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

// Scenario 1: Socket gate (ENFORCE_VERSION_GATE=true)

describe('Scenario 1: socket gate (ENFORCE_VERSION_GATE=true)', () => {
  let user: TestUser;

  beforeAll(async () => {
    process.env.ENFORCE_VERSION_GATE = 'true';
    user = await createTestUser();
  });

  afterAll(() => {
    delete process.env.ENFORCE_VERSION_GATE;
  });

  // 1-A: Old-but-inside-window client connects successfully
  it('1-A: client with buildDate inside window connects without must-update', async () => {
    const socket = track(await mockHandshakeAsOldClient(baseUrl, user.token, COMPAT_WINDOW_DAYS - 1));
    expect(socket.connected).toBe(true);

    // Verify no must-update arrives within 500ms
    let gotMustUpdate = false;
    socket.on('must-update', () => { gotMustUpdate = true; });
    await new Promise((r) => setTimeout(r, 500));
    expect(gotMustUpdate).toBe(false);

    // Can emit a benign event without being kicked
    expect(socket.connected).toBe(true);
  });

  // 1-B: Expired client gets must-update and is disconnected
  it('1-B: expired client receives must-update and is disconnected', async () => {
    const { socket, mustUpdateEvent } = await mockHandshakeAsExpiredClient(baseUrl, user.token);
    track(socket);

    expect(mustUpdateEvent).toBeDefined();
    expect(mustUpdateEvent!.reason).toBe('buildDate');
    expect(mustUpdateEvent!.autoUpdateHint).toBe(true);
    // Server calls disconnect(true) after 250ms timeout; by the time
    // mockHandshakeAsExpiredClient resolves, the socket should be disconnected.
    expect(socket.connected).toBe(false);
  });

  // 1-C: Client with protocolVersion=0 (below MIN_SUPPORTED) is rejected
  it('1-C: client with protocolVersion=0 receives must-update with reason=protocolVersion', async () => {
    // protocolVersion=0 is parsed as null by parseProtocolContext, so
    // isHandshakeInsideWindow returns { ok: false, reason: 'protocolVersion' }.
    // However the current implementation checks protocolVersion===null first,
    // which means the reason field depends on parsing order. With buildDate
    // present and valid, the null protocolVersion is the failing check.
    const result = await new Promise<{ mustUpdateEvent?: { reason: string; autoUpdateHint: boolean }; disconnected: boolean }>((resolve) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: {
          token: user.token,
          buildDate: buildDateDaysAgo(5), // fresh build date
          protocolVersion: 0,
          capabilities: [],
        },
        forceNew: true,
        reconnection: false,
      });
      track(socket);

      let mustUpdateEvent: { reason: string; autoUpdateHint: boolean } | undefined;
      socket.on('must-update', (data: { reason: string; autoUpdateHint: boolean }) => {
        mustUpdateEvent = data;
      });
      socket.on('disconnect', () => resolve({ mustUpdateEvent, disconnected: true }));
      setTimeout(() => resolve({ mustUpdateEvent, disconnected: !socket.connected }), 2000);
    });

    expect(result.mustUpdateEvent).toBeDefined();
    // protocolVersion=0 is parsed as null, so isHandshakeInsideWindow sees
    // null protocolVersion and returns reason='protocolVersion'.
    expect(result.mustUpdateEvent!.reason).toBe('protocolVersion');
    expect(result.mustUpdateEvent!.autoUpdateHint).toBe(true);
    expect(result.disconnected).toBe(true);
  });

  // 1-D: Client missing all three handshake fields is treated as expired
  it('1-D: client with no handshake fields receives must-update', async () => {
    const result = await new Promise<{ mustUpdateEvent?: { reason: string; autoUpdateHint: boolean }; disconnected: boolean }>((resolve) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token: user.token },
        forceNew: true,
        reconnection: false,
      });
      track(socket);

      let mustUpdateEvent: { reason: string; autoUpdateHint: boolean } | undefined;
      socket.on('must-update', (data: { reason: string; autoUpdateHint: boolean }) => {
        mustUpdateEvent = data;
      });
      socket.on('disconnect', () => resolve({ mustUpdateEvent, disconnected: true }));
      setTimeout(() => resolve({ mustUpdateEvent, disconnected: !socket.connected }), 2000);
    });

    expect(result.mustUpdateEvent).toBeDefined();
    // Missing buildDate → parsed as null → reason='buildDate'
    expect(result.mustUpdateEvent!.reason).toBe('buildDate');
    expect(result.mustUpdateEvent!.autoUpdateHint).toBe(true);
    expect(result.disconnected).toBe(true);
  });

  // 1-E: Client in soft-warning window (45-60 days) connects + gets update-recommended
  it('1-E: client with buildDate at soft-warning boundary gets update-recommended', async () => {
    // Use SOFT_WARNING_DAYS + 1 = 46 days old: inside the 60-day window
    // but past the 45-day soft warning threshold.
    const softDate = buildDateDaysAgo(SOFT_WARNING_DAYS + 1);

    const result = await new Promise<{ connected: boolean; updateRecommended: boolean; mustUpdate: boolean }>((resolve) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: {
          token: user.token,
          buildDate: softDate,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          capabilities: [...KNOWN_CAPABILITIES],
        },
        forceNew: true,
        reconnection: false,
      });
      track(socket);

      let gotRecommended = false;
      let gotMustUpdate = false;
      socket.on('update-recommended', () => { gotRecommended = true; });
      socket.on('must-update', () => { gotMustUpdate = true; });
      socket.on('connect', () => {
        setTimeout(() => resolve({
          connected: socket.connected,
          updateRecommended: gotRecommended,
          mustUpdate: gotMustUpdate,
        }), 500);
      });
      socket.on('connect_error', () => resolve({ connected: false, updateRecommended: false, mustUpdate: false }));
    });

    expect(result.connected).toBe(true);
    expect(result.updateRecommended).toBe(true);
    expect(result.mustUpdate).toBe(false);
  });
});

// Scenario 2: REST gate at /livekit (ENFORCE_VERSION_GATE=true)

describe('Scenario 2: REST gate at /livekit (ENFORCE_VERSION_GATE=true)', () => {
  let user: TestUser;

  beforeAll(async () => {
    process.env.ENFORCE_VERSION_GATE = 'true';
    user = await createTestUser();
  });

  afterAll(() => {
    delete process.env.ENFORCE_VERSION_GATE;
  });

  // 2-A: Missing X-Client-Build-Date header → 426
  it('2-A: request without X-Client-Build-Date gets 426', async () => {
    const addr = httpServer.address() as AddressInfo;
    const res = await request(`http://127.0.0.1:${addr.port}`)
      .post('/api/v1/livekit/token')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ roomName: 'voice:test-room', participantName: 'tester' });

    expect(res.status).toBe(426);
    expect(res.body).toHaveProperty('reason', 'buildDate');
    expect(res.body).toHaveProperty('autoUpdateHint', true);
  });

  // 2-B: Old buildDate header → 426
  it('2-B: request with expired X-Client-Build-Date gets 426', async () => {
    const addr = httpServer.address() as AddressInfo;
    const res = await request(`http://127.0.0.1:${addr.port}`)
      .post('/api/v1/livekit/token')
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Client-Build-Date', buildDateDaysAgo(COMPAT_WINDOW_DAYS + 5))
      .set('X-Protocol-Version', String(CURRENT_PROTOCOL_VERSION))
      .set('X-Client-Capabilities', KNOWN_CAPABILITIES.join(','))
      .send({ roomName: 'voice:test-room', participantName: 'tester' });

    expect(res.status).toBe(426);
    expect(res.body).toHaveProperty('reason', 'buildDate');
    expect(res.body).toHaveProperty('autoUpdateHint', true);
  });

  // 2-C: Current buildDate header → request proceeds (not 426)
  it('2-C: request with current X-Client-Build-Date is not blocked by gate', async () => {
    const addr = httpServer.address() as AddressInfo;
    const res = await request(`http://127.0.0.1:${addr.port}`)
      .post('/api/v1/livekit/token')
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Client-Build-Date', buildDateDaysAgo(5))
      .set('X-Protocol-Version', String(CURRENT_PROTOCOL_VERSION))
      .set('X-Client-Capabilities', KNOWN_CAPABILITIES.join(','))
      .send({ roomName: 'voice:test-room', participantName: 'tester' });

    // Should NOT be 426. May be 400 (invalid room), 401, or 200 depending
    // on test setup, but the version gate must not block.
    expect(res.status).not.toBe(426);
  });

  // 2-D: /auth/refresh is exempted from the version gate
  it('2-D: /auth/refresh without headers is not blocked by version gate', async () => {
    const addr = httpServer.address() as AddressInfo;
    // No X-Client-Build-Date, no X-Protocol-Version — the refresh endpoint
    // must still be reachable. We don't have a valid refresh cookie here,
    // so the endpoint itself may return 400/401, but NOT 426.
    const res = await request(`http://127.0.0.1:${addr.port}`)
      .post('/api/v1/auth/refresh');

    // The version gate is only mounted on /livekit, not on /auth, so
    // /auth/refresh never hits enforceVersionGateHttp. Confirm it's not 426.
    expect(res.status).not.toBe(426);
  });
});

// Scenario 3: Gate disabled (ENFORCE_VERSION_GATE=false, the default)

describe('Scenario 3: gate disabled (ENFORCE_VERSION_GATE=false)', () => {
  let user: TestUser;

  beforeAll(async () => {
    // Explicitly unset to guarantee permissive mode
    delete process.env.ENFORCE_VERSION_GATE;
    user = await createTestUser();
  });

  // 3-A: Expired client connects without must-update
  it('3-A: expired client connects successfully in permissive mode', async () => {
    const socket = await connectSocketWithAuth({
      token: user.token,
      buildDate: buildDateDaysAgo(COMPAT_WINDOW_DAYS + 10),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      capabilities: [],
    });

    expect(socket.connected).toBe(true);

    let gotMustUpdate = false;
    socket.on('must-update', () => { gotMustUpdate = true; });
    await new Promise((r) => setTimeout(r, 500));
    expect(gotMustUpdate).toBe(false);
    expect(socket.connected).toBe(true);
  });

  // 3-B: Expired client hits /livekit/token without 426
  it('3-B: expired client hits /livekit/token without 426 in permissive mode', async () => {
    const addr = httpServer.address() as AddressInfo;
    const res = await request(`http://127.0.0.1:${addr.port}`)
      .post('/api/v1/livekit/token')
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Client-Build-Date', buildDateDaysAgo(COMPAT_WINDOW_DAYS + 10))
      .set('X-Protocol-Version', String(CURRENT_PROTOCOL_VERSION))
      .set('X-Client-Capabilities', KNOWN_CAPABILITIES.join(','))
      .send({ roomName: 'voice:test-room', participantName: 'tester' });

    // Not 426 — gate is off. May be 400/401/500 depending on LK config,
    // but never 426.
    expect(res.status).not.toBe(426);
  });
});
