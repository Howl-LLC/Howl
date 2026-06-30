// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * When the consume route serves a reusable last-resort package (the victim's
 * single-use pool is drained → forward-secrecy degrading), the server
 * emits a debounced `mls-keypackage-low-water` signal to the victim so the
 * degradation is not silent. The signal carries no callerId (don't reveal who),
 * and is debounced so it cannot be turned into a notification-bomb.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server as SocketServer } from 'socket.io';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';
import { setIO } from '../../src/socketIO.js';

interface Captured { room: string; event: string; payload: unknown }
const captured: Captured[] = [];

let target: TestUser;
let consumer: TestUser;
let device: string;

async function publishLastResort(uId: string, dId: string, token: string) {
  const c = await HarnessClient.create(uId, dId);
  await seedMlsPublisherAik(uId, c.aikPublicKeyB64());
  const kp = await c.publishKeyPackageWithStableSigningKeyB64();
  const res = await request(app).post('/api/v1/mls/keypackages').set('Authorization', authHeader(token)).send({ deviceId: dId, keyPackages: [{ keyPackage: kp, isLastResort: true }] });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  // Fake Socket.IO server: record every emit so we can assert the victim signal.
  const fakeIo = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { captured.push({ room, event, payload }); } }),
  };
  setIO(fakeIo as unknown as SocketServer);

  target = await createTestUser();
  consumer = await createTestUser();
  device = randomUUID();
  await publishLastResort(target.id, device, target.token); // only a last-resort → consume drains to last-resort
});
afterAll(async () => {
  await prisma.mlsKeyPackage.deleteMany({});
  await cleanupTestData();
});

describe('victim low-water / last-resort-in-use signal', () => {
  it('emits a debounced mls-keypackage-low-water to the victim when a last-resort package is served', async () => {
    const res = await request(app).get(`/api/v1/mls/keypackages/${target.id}`).set('Authorization', authHeader(consumer.token));
    expect(res.status).toBe(200);
    expect(res.body.keyPackages[0].isLastResort).toBe(true);

    const signals = captured.filter((c) => c.event === 'mls-keypackage-low-water' && c.room === `user:${target.id}`);
    expect(signals).toHaveLength(1);
    expect(JSON.stringify(signals[0].payload)).not.toContain(consumer.id); // must not reveal who triggered it
  });

  it('debounces: a second last-resort serve within the window does not re-emit', async () => {
    const before = captured.filter((c) => c.event === 'mls-keypackage-low-water').length;
    const res = await request(app).get(`/api/v1/mls/keypackages/${target.id}`).set('Authorization', authHeader(consumer.token));
    expect(res.status).toBe(200);
    const after = captured.filter((c) => c.event === 'mls-keypackage-low-water').length;
    expect(after).toBe(before);
  });
});
