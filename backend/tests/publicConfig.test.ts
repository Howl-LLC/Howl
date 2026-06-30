// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { cleanupTestData } from './helpers.js';
import { prisma } from '../src/db.js';

const saved = { SELF_HOST: process.env.SELF_HOST, INSTANCE_NAME: process.env.INSTANCE_NAME };
afterEach(() => {
  for (const k of ['SELF_HOST', 'INSTANCE_NAME'] as const) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
  }
});

describe('GET /api/v1/public/config', () => {
  it('serves instance config unauthenticated', async () => {
    const res = await request(app).get('/api/v1/public/config');
    expect(res.status).toBe(200);
    for (const key of ['instanceName', 'selfHost', 'registrationMode', 'voiceEnabled', 'billingEnabled']) {
      expect(res.body).toHaveProperty(key);
    }
  });
  it('does not leak a livekitUrl when voice is disabled', async () => {
    // No real LiveKit creds in the test env => isVoiceEnabled() false => no URL.
    const res = await request(app).get('/api/v1/public/config');
    expect(res.body.voiceEnabled).toBe(false);
    expect(res.body.livekitUrl).toBe('');
  });
  it('reflects self-host flags', async () => {
    process.env.SELF_HOST = 'true';
    process.env.INSTANCE_NAME = 'Test Island';
    const res = await request(app).get('/api/v1/public/config');
    expect(res.body.selfHost).toBe(true);
    expect(res.body.instanceName).toBe('Test Island');
    expect(res.body.billingEnabled).toBe(false);
  });
  it('needsBootstrap mirrors the zero-users state under self-host', async () => {
    process.env.SELF_HOST = 'true';
    // Serial test run (fileParallelism: false) => no concurrent writes between
    // the request and the count, so this equality always holds for any DB state.
    const res = await request(app).get('/api/v1/public/config');
    expect(res.body.needsBootstrap).toBe((await prisma.user.count()) === 0);
  });
  it('needsBootstrap is true on a fresh self-host instance (zero users)', async () => {
    process.env.SELF_HOST = 'true';
    await cleanupTestData(); // zero users
    const res = await request(app).get('/api/v1/public/config');
    expect(res.body.needsBootstrap).toBe(true);
  });
  it('needsBootstrap is falsy when not self-host (never queries the DB)', async () => {
    delete process.env.SELF_HOST;
    const res = await request(app).get('/api/v1/public/config');
    expect(res.body.selfHost).toBe(false);
    expect(res.body.needsBootstrap).toBeFalsy();
  });
});
