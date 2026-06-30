// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

let user: TestUser;
let createdServerId: string;

beforeAll(async () => {
  user = await createTestUser();
});

afterAll(cleanupTestData);

describe('POST /api/servers', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/servers')
      .send({ name: 'Unauthorized Server' });

    expect(res.status).toBe(401);
  });

  it('returns 201 with valid auth and server data', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', authHeader(user.token))
      .send({ name: 'My Test Server' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('My Test Server');
    createdServerId = res.body.id;
  });

  it('uses default name when name is omitted', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', authHeader(user.token))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Server');
  });
});

describe('GET /api/servers', () => {
  it('returns the created server in the list', async () => {
    const res = await request(app)
      .get('/api/servers')
      .set('Authorization', authHeader(user.token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const match = res.body.find((s: { id: string }) => s.id === createdServerId);
    expect(match).toBeDefined();
    expect(match.name).toBe('My Test Server');
  });
});

describe('GET /api/servers/:serverId/members', () => {
  it('returns at least the owner as a member', async () => {
    const res = await request(app)
      .get(`/api/servers/${createdServerId}/members`)
      .set('Authorization', authHeader(user.token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);

    const owner = res.body.members.find((m: { id: string }) => m.id === user.id);
    expect(owner).toBeDefined();
    expect(owner.username).toBe(user.username);
  });

  it('returns 403 for a non-existent server', async () => {
    const res = await request(app)
      .get('/api/servers/00000000-0000-0000-0000-000000000000/members')
      .set('Authorization', authHeader(user.token));

    expect([403, 404]).toContain(res.status);
  });
});

describe('Role create/update blocksSelfRoles', () => {
  let owner: TestUser;
  let serverId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id, 'Roles Server');
    serverId = server.id;
  });

  it('role create + update round-trips blocksSelfRoles', async () => {
    const create = await request(app).post(`/api/v1/servers/${serverId}/roles`).set('Authorization', authHeader(owner.token))
      .send({ name: 'Restricted', color: '#ff0000', blocksSelfRoles: true });
    expect(create.status).toBe(201);
    expect(create.body.blocksSelfRoles).toBe(true);

    // gap-fill: created role's blocksSelfRoles surfaces in the GET /roles list
    const list = await request(app).get(`/api/v1/servers/${serverId}/roles`).set('Authorization', authHeader(owner.token));
    expect(list.status).toBe(200);
    const listed = list.body.find((r: { id: string }) => r.id === create.body.id);
    expect(listed.blocksSelfRoles).toBe(true);

    const upd = await request(app).put(`/api/v1/servers/${serverId}/roles/${create.body.id}`).set('Authorization', authHeader(owner.token))
      .send({ blocksSelfRoles: false });
    expect(upd.status).toBe(200);
    expect(upd.body.blocksSelfRoles).toBe(false);
  });
});
