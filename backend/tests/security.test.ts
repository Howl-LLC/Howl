// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';
import { prisma } from '../src/db.js';

afterAll(async () => { await cleanupTestData(); });

describe('Permission boundaries', () => {
  it('non-member cannot read channel messages', async () => {
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const server = await createTestServer(owner.id);
    const channelId = server.channels[0].id;

    const res = await request(app)
      .get(`/api/messages/channels/${channelId}`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(res.status).toBe(403);
  });

  it('non-member cannot send messages to a channel', async () => {
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const server = await createTestServer(owner.id);
    const channelId = server.channels[0].id;

    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ content: 'unauthorized message' });
    expect(res.status).toBe(403);
  });

  it('member without manageRoles cannot create roles', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const server = await createTestServer(owner.id);

    await prisma.serverMember.create({
      data: { userId: member.id, serverId: server.id, role: 'member' },
    });

    const res = await request(app)
      .post(`/api/servers/${server.id}/roles`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Hacked Role' });
    expect(res.status).toBe(403);
  });

  it('regular user cannot access admin endpoints', async () => {
    const user = await createTestUser();
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(401);
  });
});

describe('Auth bypass attempts', () => {
  it('expired JWT is rejected', async () => {
    const user = await createTestUser();
    const expired = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'test-jwt-secret-for-vitest', { expiresIn: '0s' });
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('JWT with wrong secret is rejected', async () => {
    const user = await createTestUser();
    const bad = jwt.sign({ userId: user.id }, 'wrong-secret', { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('MFA token (purpose: mfa) cannot be used as access token', async () => {
    const user = await createTestUser();
    const mfaToken = jwt.sign({ userId: user.id, purpose: 'mfa' }, process.env.JWT_SECRET || 'test-jwt-secret-for-vitest', { expiresIn: '5m' });
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${mfaToken}`);
    expect(res.status).toBe(401);
  });
});

describe('Input validation', () => {
  it('invalid UUID in path params returns 400', async () => {
    const user = await createTestUser();
    const res = await request(app)
      .get('/api/messages/channels/not-a-uuid')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(400);
  });

  it('role creation with non-hex color is rejected', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const res = await request(app)
      .post(`/api/servers/${server.id}/roles`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Bad Color', color: 'red; } body {' });
    expect(res.status).toBe(400);
  });

  it('role permissions reject unknown keys', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const res = await request(app)
      .post(`/api/servers/${server.id}/roles`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Test Role', permissions: { unknownPermission: true } });
    expect(res.status).toBe(400);
  });

  it('URL fields reject javascript: protocol', async () => {
    const user = await createTestUser();
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ avatar: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });
});
