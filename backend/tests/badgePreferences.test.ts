// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData } from './helpers.js';
import type { TestUser } from './helpers.js';

let user: TestUser;
beforeAll(async () => { user = await createTestUser(); });
afterAll(async () => { await cleanupTestData(); });

describe('badgeDisplay preference (PATCH/GET /auth/me/preferences)', () => {
  it('requires auth', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/me/preferences')
      .send({ badgeDisplay: { hidden: [], order: [] } });
    expect(res.status).toBe(401);
  });

  it('persists a valid badgeDisplay and returns it', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/me/preferences')
      .set('Authorization', authHeader(user.token))
      .send({ badgeDisplay: { hidden: ['beta'], order: ['pro', 'beta'] } });
    expect(res.status).toBe(200);
    expect(res.body.badgeDisplay).toEqual({ hidden: ['beta'], order: ['pro', 'beta'] });

    const get = await request(app)
      .get('/api/v1/auth/me/preferences')
      .set('Authorization', authHeader(user.token));
    expect(get.status).toBe(200);
    expect(get.body.badgeDisplay).toEqual({ hidden: ['beta'], order: ['pro', 'beta'] });
  });

  it('rejects unknown badge keys (enum-bounded)', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/me/preferences')
      .set('Authorization', authHeader(user.token))
      .send({ badgeDisplay: { hidden: ['not_a_badge'], order: [] } });
    expect(res.status).toBe(400);
  });

  it('rejects arrays over the max length', async () => {
    const tooMany = ['staff', 'verified', 'pro', 'pro_essential', 'beta', 'bug_hunter', 'early_supporter', 'staff'];
    const res = await request(app)
      .patch('/api/v1/auth/me/preferences')
      .set('Authorization', authHeader(user.token))
      .send({ badgeDisplay: { hidden: tooMany, order: [] } });
    expect(res.status).toBe(400);
  });
});

describe('other-user profile view honors badge prefs', () => {
  it('returns badges and reflects the target hidden deny-list', async () => {
    const target = await createTestUser();
    const viewer = await createTestUser();

    // Every fresh user auto-earns 'beta' (createdAt < BETA_CUTOFF default).
    const before = await request(app)
      .get(`/api/v1/users/${target.id}/profile`)
      .set('Authorization', authHeader(viewer.token));
    expect(before.status).toBe(200);
    expect(before.body.badges).toContain('beta');

    await request(app)
      .patch('/api/v1/auth/me/preferences')
      .set('Authorization', authHeader(target.token))
      .send({ badgeDisplay: { hidden: ['beta'], order: [] } });

    const after = await request(app)
      .get(`/api/v1/users/${target.id}/profile`)
      .set('Authorization', authHeader(viewer.token));
    expect(after.status).toBe(200);
    expect(after.body.badges ?? []).not.toContain('beta');
  });
});

describe('DM payload reflects the other user badge prefs', () => {
  it('omits a hidden badge from otherUser in GET /dms', async () => {
    const a = await createTestUser();
    const b = await createTestUser();

    const create = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(a.token))
      .send({ otherUserId: b.id });
    expect([200, 201]).toContain(create.status);

    // Positive control: before hiding, b's auto-earned 'beta' is present.
    const listBefore = await request(app).get('/api/v1/dms').set('Authorization', authHeader(a.token));
    const dmBefore = (listBefore.body as Array<{ otherUser?: { id: string; badges?: string[] } }>)
      .find((c) => c.otherUser?.id === b.id);
    expect(dmBefore?.otherUser?.badges).toContain('beta');

    await request(app)
      .patch('/api/v1/auth/me/preferences')
      .set('Authorization', authHeader(b.token))
      .send({ badgeDisplay: { hidden: ['beta'], order: [] } });

    const listAfter = await request(app).get('/api/v1/dms').set('Authorization', authHeader(a.token));
    const dmAfter = (listAfter.body as Array<{ otherUser?: { id: string; badges?: string[] } }>)
      .find((c) => c.otherUser?.id === b.id);
    expect(dmAfter?.otherUser?.badges ?? []).not.toContain('beta');
  });
});
