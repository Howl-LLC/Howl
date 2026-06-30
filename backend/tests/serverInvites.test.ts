// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createInviteSchema, updateInviteSchema } from '../src/schemas.js';
import { createTestUser, createTestServer, createTestChannel, authHeader, cleanupTestData, type TestUser } from './helpers.js';

/** Seed an @everyone role + a member-create role into the server, then add the
 *  given users to the server with the requested role permissions. Mirrors the
 *  pattern used in roleHierarchy.test.ts (no shared helper exists). */
async function addMemberWithPermissions(
  serverId: string,
  userId: string,
  permissions: Record<string, boolean>,
) {
  // Reuse @everyone if already created.
  let everyone = await prisma.serverRole.findFirst({ where: { serverId, isEveryone: true } });
  if (!everyone) {
    everyone = await prisma.serverRole.create({
      data: {
        serverId,
        name: '@everyone',
        position: 999,
        locked: true,
        isEveryone: true,
        permissions: {} as any,
      },
    });
  }
  let role = null as Awaited<ReturnType<typeof prisma.serverRole.findFirst>> | null;
  if (Object.keys(permissions).length > 0) {
    role = await prisma.serverRole.create({
      data: {
        serverId,
        name: `Role-${Math.random().toString(36).slice(2, 8)}`,
        position: 5,
        permissions: permissions as any,
      },
    });
  }
  await prisma.serverMember.create({
    data: { userId, serverId, role: 'member', roleId: role?.id ?? null },
  });
  if (role) {
    await prisma.memberRole.create({ data: { userId, serverId, roleId: role.id } });
  }
}

describe('invite schemas', () => {
  it('accepts label and shareable on createInviteSchema', () => {
    const result = createInviteSchema.safeParse({
      body: { label: 'General', shareable: true, expireAfter: 86400 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects label > 32 chars on createInviteSchema', () => {
    const result = createInviteSchema.safeParse({
      body: { label: 'x'.repeat(33) },
    });
    expect(result.success).toBe(false);
  });

  it('updateInviteSchema accepts partial label/shareable', () => {
    const result = updateInviteSchema.safeParse({
      body: { shareable: true },
    });
    expect(result.success).toBe(true);
  });

  it('updateInviteSchema accepts label: null (clear)', () => {
    const result = updateInviteSchema.safeParse({
      body: { label: null },
    });
    expect(result.success).toBe(true);
  });

  it('updateInviteSchema rejects empty body', () => {
    const result = updateInviteSchema.safeParse({ body: {} });
    expect(result.success).toBe(false);
  });
});

describe('GET /api/servers/:serverId/invites — visibility filtering', () => {
  let admin: TestUser;
  let memberWithCreate: TestUser;
  let plainMember: TestUser;
  let serverId: string;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser();
    memberWithCreate = await createTestUser();
    plainMember = await createTestUser();
    const server = await createTestServer(admin.id);
    serverId = server.id;
    await addMemberWithPermissions(serverId, memberWithCreate.id, { createInvite: true });
    await addMemberWithPermissions(serverId, plainMember.id, {});

    await prisma.invite.createMany({
      data: [
        { code: 'AAA00001', serverId, createdById: admin.id, shareable: true, label: 'Public' },
        { code: 'AAA00002', serverId, createdById: admin.id, shareable: false, label: 'Admin only' },
        { code: 'AAA00003', serverId, createdById: memberWithCreate.id, shareable: false },
      ],
    });
  });

  afterAll(cleanupTestData);

  it('admin sees all invites', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(3);
  });

  it('member with createInvite sees own + shareable only', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(memberWithCreate.token));
    expect(res.status).toBe(200);
    const codes = res.body.invites.map((i: any) => i.code).sort();
    expect(codes).toEqual(['AAA00001', 'AAA00003']);
  });

  it('plain member sees only shareable invites (empty array if none)', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(plainMember.token));
    expect(res.status).toBe(200);
    const codes = res.body.invites.map((i: any) => i.code);
    expect(codes).toEqual(['AAA00001']);
  });

  it('response includes label and shareable fields', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(admin.token));
    const labelled = res.body.invites.find((i: any) => i.code === 'AAA00001');
    expect(labelled.label).toBe('Public');
    expect(labelled.shareable).toBe(true);
  });
});

describe('POST /api/servers/:serverId/invites — label/shareable gating', () => {
  let admin: TestUser;
  let memberWithCreate: TestUser;
  let serverId: string;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser();
    memberWithCreate = await createTestUser();
    const server = await createTestServer(admin.id);
    serverId = server.id;
    await addMemberWithPermissions(serverId, memberWithCreate.id, { createInvite: true });
  });

  afterAll(cleanupTestData);

  it('admin can set label and shareable on create', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(admin.token))
      .send({ label: 'VIPs', shareable: true });
    expect(res.status).toBe(201);
    const created = await prisma.invite.findUnique({ where: { id: res.body.id } });
    expect(created?.label).toBe('VIPs');
    expect(created?.shareable).toBe(true);
  });

  it('non-admin (createInvite only) cannot set shareable: payload silently ignored', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(memberWithCreate.token))
      .send({ label: 'Mine', shareable: true });
    expect(res.status).toBe(201);
    const created = await prisma.invite.findUnique({ where: { id: res.body.id } });
    expect(created?.shareable).toBe(false);
    expect(created?.label).toBeNull();
  });

  it('POST response includes label and shareable', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(admin.token))
      .send({ label: 'X', shareable: true });
    expect(res.body.label).toBe('X');
    expect(res.body.shareable).toBe(true);
  });
});

describe('PATCH /api/servers/:serverId/invites/:inviteId', () => {
  let admin: TestUser;
  let memberWithCreate: TestUser;
  let serverId: string;
  let inviteId: string;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser();
    memberWithCreate = await createTestUser();
    const server = await createTestServer(admin.id);
    serverId = server.id;
    await addMemberWithPermissions(serverId, memberWithCreate.id, { createInvite: true });
    const inv = await prisma.invite.create({
      data: { code: 'PATCH001', serverId, createdById: admin.id },
    });
    inviteId = inv.id;
  });

  afterAll(cleanupTestData);

  it('admin can set label and shareable', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ label: 'Renamed', shareable: true });
    expect(res.status).toBe(200);
    const updated = await prisma.invite.findUnique({ where: { id: inviteId } });
    expect(updated?.label).toBe('Renamed');
    expect(updated?.shareable).toBe(true);
  });

  it('admin can clear label by passing null', async () => {
    await prisma.invite.update({ where: { id: inviteId }, data: { label: 'Old' } });
    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ label: null });
    expect(res.status).toBe(200);
    const updated = await prisma.invite.findUnique({ where: { id: inviteId } });
    expect(updated?.label).toBeNull();
  });

  it('non-admin is rejected with 403', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(memberWithCreate.token))
      .send({ shareable: true });
    expect(res.status).toBe(403);
  });

  it('rejects empty body', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects label > 32 chars', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ label: 'x'.repeat(33) });
    expect(res.status).toBe(400);
  });

  it('writes invite_update audit log entry', async () => {
    await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ shareable: true });
    const log = await prisma.auditLog.findFirst({
      where: { serverId, action: 'invite_update', targetId: inviteId },
    });
    expect(log).toBeTruthy();
  });

  it('returns 404 for invite in different server', async () => {
    const otherAdmin = await createTestUser();
    const otherServer = await createTestServer(otherAdmin.id);
    const res = await request(app)
      .patch(`/api/servers/${otherServer.id}/invites/${inviteId}`)
      .set('Authorization', authHeader(otherAdmin.token))
      .send({ shareable: true });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/invites/join — auto-role assignment + welcome message', () => {
  let owner: TestUser;
  let joiner: TestUser;
  let serverId: string;
  let welcomeChannelId: string;
  let autoRoleId: string;

  beforeEach(async () => {
    await cleanupTestData();
    owner = await createTestUser();
    joiner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    // createTestServer seeds a 'general' text channel (the FIRST by createdAt).
    // Create a SECOND text channel and configure IT as the welcome channel, so
    // the assertion that the welcome message lands in welcomeChannelId is
    // non-vacuous: the pre-wiring inline code posts to the first text channel,
    // NOT the configured one.
    const welcome = await createTestChannel(serverId, 'welcome');
    welcomeChannelId = welcome.id;

    // The join path seeds a 'Member' role (low position, NOT hoisted).
    await prisma.serverRole.create({
      data: {
        serverId,
        name: 'Member',
        position: 1,
        isEveryone: false,
        displaySeparately: false,
        permissions: { sendMessages: true, viewChannels: true } as any,
      },
    });

    // Auto-role: hoisted (displaySeparately) so pickDisplayRole picks it over
    // 'Member' as the member's display role even though its position is higher.
    const autoRole = await prisma.serverRole.create({
      data: {
        serverId,
        name: 'Newcomer',
        position: 2,
        isEveryone: false,
        displaySeparately: true,
        permissions: { sendMessages: true } as any,
      },
    });
    autoRoleId = autoRole.id;
    await prisma.serverAutoRole.create({ data: { serverId, roleId: autoRoleId } });

    await prisma.serverSettings.create({
      data: {
        serverId,
        welcomeEnabled: true,
        welcomeMessage: 'Welcome {user} to {server}!',
        welcomeChannelId,
      },
    });

    await prisma.invite.create({
      data: { code: 'JOINAUTO', serverId, createdById: owner.id, useCount: 0 },
    });
  });

  afterAll(cleanupTestData);

  it('grants the configured auto-role, hoists it as display role, and posts the welcome system message', async () => {
    const res = await request(app)
      .post('/api/v1/invites/join')
      .set('Authorization', authHeader(joiner.token))
      .send({ code: 'JOINAUTO' });
    expect(res.status).toBe(200);

    // (a) joiner has the MemberRole row for the auto-role.
    const memberRoleRow = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: joiner.id, serverId, roleId: autoRoleId } },
    });
    expect(memberRoleRow).not.toBeNull();

    // (b) ServerMember.roleId == the hoisted auto-role (won over 'Member').
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: joiner.id, serverId } },
    });
    expect(member?.roleId).toBe(autoRoleId);

    // (c) a system member_join message landed in the configured welcome channel.
    const sysMsg = await prisma.message.findFirst({
      where: { channelId: welcomeChannelId, type: 'system' },
    });
    expect(sysMsg).not.toBeNull();
    expect((sysMsg?.systemPayload as any)?.kind).toBe('member_join');
  });
});
