// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * User content preferences.
 *
 * Covers:
 * - GET  /api/v1/users/me/preferences (auth required)
 * - PATCH /api/v1/users/me/preferences (auth required)
 *
 * The `explicitContentFilter` column has been dropped from User. The only
 * mutable preference remaining on this route is `discoveryOptOut`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData } from './helpers.js';
import type { TestUser } from './helpers.js';

let user: TestUser;

beforeAll(async () => {
  user = await createTestUser();
});

afterAll(async () => {
  await cleanupTestData();
});

describe('GET /api/v1/users/me/preferences', () => {
  it('rejects requests without auth', async () => {
    const res = await request(app).get('/api/v1/users/me/preferences');
    expect(res.status).toBe(401);
  });

  it('returns the default values for a fresh user', async () => {
    const res = await request(app)
      .get('/api/v1/users/me/preferences')
      .set('Authorization', authHeader(user.token));
    expect(res.status).toBe(200);
    expect(res.body.discoveryOptOut).toBe(false);
  });
});

describe('PATCH /api/v1/users/me/preferences', () => {
  it('rejects requests without auth', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me/preferences')
      .send({ discoveryOptOut: true });
    expect(res.status).toBe(401);
  });

  it('updates discoveryOptOut', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me/preferences')
      .set('Authorization', authHeader(user.token))
      .send({ discoveryOptOut: true });
    expect(res.status).toBe(200);
    expect(res.body.discoveryOptOut).toBe(true);
  });

  it('rejects empty bodies with 400', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me/preferences')
      .set('Authorization', authHeader(user.token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects unknown body fields via .strict()', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me/preferences')
      .set('Authorization', authHeader(user.token))
      .send({ discoveryOptOut: false, somethingElse: 'oh' });
    expect(res.status).toBe(400);
  });
});
