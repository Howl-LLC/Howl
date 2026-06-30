// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests that the token refresh endpoint is exempt from the version gate.
 *
 * If a stale-build client's access token expires, it MUST be able to hit
 * /auth/refresh without getting 426. Otherwise
 * the user is bricked — they can't get a new token and can't reach any endpoint
 * that would tell them to update.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, cleanupTestData } from './helpers.js';
import type { TestUser } from './helpers.js';

let testUser: TestUser;
const originalEnv = process.env.ENFORCE_VERSION_GATE;

beforeAll(async () => {
  testUser = await createTestUser();
});

afterAll(async () => {
  await cleanupTestData();
});

describe('version gate refresh exemption', () => {
  beforeEach(() => {
    process.env.ENFORCE_VERSION_GATE = 'true';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENFORCE_VERSION_GATE = originalEnv;
    } else {
      delete process.env.ENFORCE_VERSION_GATE;
    }
  });

  it('does NOT return 426 on /auth/refresh with an expired build date', async () => {
    // Use a build date that's well outside the 60-day compat window
    const expiredBuildDate = '2024-01-01';

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('X-Client-Build-Date', expiredBuildDate)
      .set('X-Protocol-Version', '1')
      .set('X-Client-Capabilities', 'sframe.v1');

    // Without a valid refresh cookie, the server will return 401 (no session).
    // The key assertion: it must NOT be 426. The refresh endpoint is exempt
    // from the version gate so the user can recover.
    expect(res.status).not.toBe(426);
  });

  it('does NOT return 426 on /auth/refresh with missing protocol headers', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh');

    // Again: should be 401 (no cookie) or similar, never 426
    expect(res.status).not.toBe(426);
  });

  it('DOES return 426 on /livekit/token with an expired build date', async () => {
    // Verify the gate is actually enforced on non-exempt paths
    const expiredBuildDate = '2024-01-01';

    const res = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', `Bearer ${testUser.token}`)
      .set('X-Client-Build-Date', expiredBuildDate)
      .set('X-Protocol-Version', '1')
      .set('X-Client-Capabilities', 'sframe.v1');

    expect(res.status).toBe(426);
    expect(res.body).toHaveProperty('reason');
  });

  it('returns 426 on /livekit/token via the /api backward-compat alias', async () => {
    const expiredBuildDate = '2024-01-01';

    const res = await request(app)
      .post('/api/livekit/token')
      .set('Authorization', `Bearer ${testUser.token}`)
      .set('X-Client-Build-Date', expiredBuildDate)
      .set('X-Protocol-Version', '1')
      .set('X-Client-Capabilities', 'sframe.v1');

    expect(res.status).toBe(426);
  });
});
