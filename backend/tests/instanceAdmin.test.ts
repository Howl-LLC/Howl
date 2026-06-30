// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, cleanupTestData, uniqueEmail, uniqueUsername } from './helpers.js';
import { prisma } from '../src/db.js';

const savedSelfHost = process.env.SELF_HOST;
let adminToken: string;
let memberToken: string;

beforeAll(async () => {
  process.env.SELF_HOST = 'true';
  const admin = await createTestUser();
  await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  adminToken = admin.token;
  const member = await createTestUser();
  memberToken = member.token;
});
afterAll(async () => {
  if (savedSelfHost === undefined) delete process.env.SELF_HOST; else process.env.SELF_HOST = savedSelfHost;
  await cleanupTestData();
});

describe('instance-admin endpoints', () => {
  it('admin can create a verified user', async () => {
    const res = await request(app).post('/api/v1/instance/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: uniqueUsername(), email: uniqueEmail(), password: 'StrongPass1!xx' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    const created = await prisma.user.findUnique({ where: { id: res.body.id }, select: { emailVerified: true, role: true } });
    expect(created?.emailVerified).toBe(true);
    expect(created?.role).toBe('USER');
  });

  it('retries on a discriminator collision and still creates the user', async () => {
    // Force the first user.create to hit a username+discriminator unique-conflict
    // (P2002), then fall through to the real create. The handler must retry with a
    // fresh discriminator rather than 500.
    const realCreate = prisma.user.create.bind(prisma.user);
    const spy = vi.spyOn(prisma.user, 'create')
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002', meta: { target: ['username', 'discriminator'] },
        });
      })
      .mockImplementation(((args: Parameters<typeof realCreate>[0]) => realCreate(args)) as typeof realCreate);
    try {
      const res = await request(app).post('/api/v1/instance/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ username: uniqueUsername(), email: uniqueEmail(), password: 'StrongPass1!xx' });
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('non-admin is forbidden', async () => {
    const res = await request(app).post('/api/v1/instance/users')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ username: uniqueUsername(), email: uniqueEmail(), password: 'StrongPass1!xx' });
    expect(res.status).toBe(403);
  });

  it('admin can reset a user password', async () => {
    const target = await createTestUser();
    const res = await request(app).post(`/api/v1/instance/users/${target.id}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newPassword: 'BrandNewPass2!xx' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when not self-host', async () => {
    delete process.env.SELF_HOST;
    const res = await request(app).post('/api/v1/instance/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: uniqueUsername(), email: uniqueEmail(), password: 'StrongPass1!xx' });
    expect(res.status).toBe(404);
    process.env.SELF_HOST = 'true';
  });
});
