// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Onboarding + welcome-channel settings, `required` picker categories, and the
 * member-side @me onboarding-complete endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

describe('Onboarding + welcome-channel settings', () => {
  let owner: TestUser;
  let serverId: string;
  let textChannelId: string;
  let voiceChannelId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    // The first text channel created by createTestServer is "general".
    const general = server.channels.find((c) => c.type === 'text');
    textChannelId = general!.id;

    // A voice channel in the same server — used to prove welcomeChannelId
    // rejects non-text channels.
    const voice = await prisma.channel.create({
      data: { id: randomUUID(), serverId, name: 'Voice', type: 'voice', position: 5 },
    });
    voiceChannelId = voice.id;
  });

  afterAll(cleanupTestData);

  it('persists welcomeChannelId (text channel) and onboardingEnabled', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ welcomeChannelId: textChannelId, onboardingEnabled: true });
    expect(res.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token));
    expect(get.status).toBe(200);
    expect(get.body.welcomeChannelId).toBe(textChannelId);
    expect(get.body.onboardingEnabled).toBe(true);
  });

  it('rejects a voice channel id for welcomeChannelId (400 channel_not_in_server)', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ welcomeChannelId: voiceChannelId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('channel_not_in_server');
  });

  it('clears welcomeChannelId on null', async () => {
    // First set it.
    await request(app)
      .patch(`/api/v1/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ welcomeChannelId: textChannelId });

    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ welcomeChannelId: null });
    expect(res.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token));
    expect(get.body.welcomeChannelId).toBeNull();
  });
});

describe('Role picker `required` categories', () => {
  let owner: TestUser;
  let serverId: string;
  let pickerId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;

    const ch = await request(app)
      .post(`/api/v1/servers/${serverId}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'pick-roles', type: 'role_picker' });
    expect(ch.status).toBe(201);

    const picker = await prisma.rolePickerChannel.findUnique({ where: { serverId } });
    pickerId = picker!.id;
  });

  afterAll(cleanupTestData);

  it('create with required:true → picker tree shows required===true', async () => {
    const created = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'Pick one', pickMode: 'single', required: true });
    expect(created.status).toBe(201);
    const catId = created.body.id;

    const tree = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
      .set('Authorization', authHeader(owner.token));
    expect(tree.status).toBe(200);
    const cat = tree.body.categories.find((c: { id: string }) => c.id === catId);
    expect(cat).toBeDefined();
    expect(cat.required).toBe(true);
  });

  it('PATCH required:false → picker tree shows required===false', async () => {
    const created = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'Toggleable', pickMode: 'multi', required: true });
    const catId = created.body.id;

    const patch = await request(app)
      .patch(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories/${catId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ required: false });
    expect(patch.status).toBe(200);

    const tree = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
      .set('Authorization', authHeader(owner.token));
    const cat = tree.body.categories.find((c: { id: string }) => c.id === catId);
    expect(cat.required).toBe(false);
  });
});

describe('@me onboarding-complete', () => {
  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let serverId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    member = await createTestUser();
    stranger = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    await prisma.serverMember.create({ data: { serverId, userId: member.id, role: 'member' } });
  });

  afterAll(cleanupTestData);

  it('stamps onboardingCompletedAt and is reflected in @me/profile', async () => {
    // Pre-condition: profile shows null before completion.
    const before = await request(app)
      .get(`/api/v1/servers/${serverId}/members/@me/profile`)
      .set('Authorization', authHeader(member.token));
    expect(before.status).toBe(200);
    expect(before.body.onboardingCompletedAt).toBeNull();

    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/members/@me/onboarding`)
      .set('Authorization', authHeader(member.token))
      .send({ completed: true });
    expect(res.status).toBe(200);
    expect(typeof res.body.onboardingCompletedAt).toBe('string');

    const after = await request(app)
      .get(`/api/v1/servers/${serverId}/members/@me/profile`)
      .set('Authorization', authHeader(member.token));
    expect(after.body.onboardingCompletedAt).toBe(res.body.onboardingCompletedAt);
  });

  it('is idempotent — second call returns the same timestamp', async () => {
    const first = await request(app)
      .patch(`/api/v1/servers/${serverId}/members/@me/onboarding`)
      .set('Authorization', authHeader(member.token))
      .send({ completed: true });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/v1/servers/${serverId}/members/@me/onboarding`)
      .set('Authorization', authHeader(member.token))
      .send({ completed: true });
    expect(second.status).toBe(200);
    expect(second.body.onboardingCompletedAt).toBe(first.body.onboardingCompletedAt);
  });

  it('non-member → 403', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/members/@me/onboarding`)
      .set('Authorization', authHeader(stranger.token))
      .send({ completed: true });
    expect(res.status).toBe(403);
  });

  it('{completed:false} → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/members/@me/onboarding`)
      .set('Authorization', authHeader(member.token))
      .send({ completed: false });
    expect(res.status).toBe(400);
  });

  it('missing body → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/members/@me/onboarding`)
      .set('Authorization', authHeader(member.token))
      .send({});
    expect(res.status).toBe(400);
  });
});
