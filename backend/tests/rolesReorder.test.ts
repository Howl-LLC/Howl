// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for POST /api/servers/:serverId/roles/reorder.
 *
 * Howl convention: lower position number = higher authority. Owner is pinned
 * at position 0; @everyone at position 1000 (out of the user-controlled
 * range). The reorder endpoint accepts a top-to-bottom list of every
 * non-@everyone role ID and rewrites positions atomically with a hierarchy
 * gate that prevents non-Owner callers from touching anything at or above
 * their own effective position.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

let owner: TestUser;
let admin: TestUser;
let modUser: TestUser;
let serverId: string;
let ownerRoleId: string;
let adminRoleId: string;
let founderRoleId: string;
let modRoleId: string;
let memberRoleId: string;
let everyoneRoleId: string;

async function seedRoles(server: { id: string }) {
  const owner = await prisma.serverRole.create({
    data: { serverId: server.id, name: 'Owner', color: '#f59e0b', style: 'solid', position: 0, locked: true, permissions: { administrator: true } },
  });
  const adminRole = await prisma.serverRole.create({
    data: { serverId: server.id, name: 'Admin', color: '#ef4444', style: 'solid', position: 1, permissions: { manageRoles: true, kickMembers: true } },
  });
  const founder = await prisma.serverRole.create({
    data: { serverId: server.id, name: 'Founder', color: '#3b82f6', style: 'solid', position: 2, permissions: {} },
  });
  const mod = await prisma.serverRole.create({
    data: { serverId: server.id, name: 'Mod', color: '#8b5cf6', style: 'solid', position: 3, permissions: { manageRoles: true } },
  });
  const member = await prisma.serverRole.create({
    data: { serverId: server.id, name: 'Member', color: '#06b6d4', style: 'solid', position: 4, permissions: {} },
  });
  const everyone = await prisma.serverRole.create({
    data: { serverId: server.id, name: '@everyone', color: '#99aab5', style: 'solid', position: 1000, locked: true, isEveryone: true, permissions: {} },
  });
  return { owner, adminRole, founder, mod, member, everyone };
}

async function joinServer(user: TestUser, roleIds: string[]) {
  await prisma.serverMember.create({
    data: { userId: user.id, serverId, role: 'member', roleId: roleIds[0] ?? null },
  });
  for (const roleId of roleIds) {
    await prisma.memberRole.create({ data: { userId: user.id, serverId, roleId } });
  }
}

async function getRolesByPosition(): Promise<Array<{ id: string; name: string; position: number }>> {
  const r = await prisma.serverRole.findMany({
    where: { serverId },
    orderBy: { position: 'asc' },
    select: { id: true, name: true, position: true },
  });
  return r;
}

describe('POST /api/servers/:serverId/roles/reorder', () => {
  beforeAll(async () => {
    owner = await createTestUser();
    admin = await createTestUser();
    modUser = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    const seeded = await seedRoles(server);
    ownerRoleId = seeded.owner.id;
    adminRoleId = seeded.adminRole.id;
    founderRoleId = seeded.founder.id;
    modRoleId = seeded.mod.id;
    memberRoleId = seeded.member.id;
    everyoneRoleId = seeded.everyone.id;
    // owner already in members from createTestServer; pin them to Owner role.
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: owner.id, serverId } },
      data: { role: 'owner', roleId: ownerRoleId },
    });
    await prisma.memberRole.create({ data: { userId: owner.id, serverId, roleId: ownerRoleId } });
    await joinServer(admin, [adminRoleId]);
    await joinServer(modUser, [modRoleId]);
  });

  afterAll(async () => {
    await prisma.memberRole.deleteMany({ where: { serverId } }).catch(() => {});
    await prisma.serverMember.deleteMany({ where: { serverId } }).catch(() => {});
    await prisma.serverRole.deleteMany({ where: { serverId } }).catch(() => {});
    await cleanupTestData();
  });

  it('Owner can reorder custom roles freely (Founder ↔ Mod swap)', async () => {
    // Move Founder (pos 2) to below Mod (pos 3): Owner, Admin, Mod, Founder, Member.
    const newOrder = [ownerRoleId, adminRoleId, modRoleId, founderRoleId, memberRoleId];
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: newOrder });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await getRolesByPosition();
    expect(after.map((r) => r.name)).toEqual(['Owner', 'Admin', 'Mod', 'Founder', 'Member', '@everyone']);
    // Sequential 0..n-1 for orderable roles, @everyone pinned high.
    expect(after[0].position).toBe(0);
    expect(after[1].position).toBe(1);
    expect(after[2].position).toBe(2);
    expect(after[3].position).toBe(3);
    expect(after[4].position).toBe(4);
    expect(after[5].position).toBe(1000);

    // Restore for the next test.
    await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, founderRoleId, modRoleId, memberRoleId] })
      .expect(200);
  });

  it('rejects when Owner is not at index 0', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: [adminRoleId, ownerRoleId, founderRoleId, modRoleId, memberRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner must remain at the top/i);
  });

  it('rejects when @everyone is included in the list (returns 409)', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, founderRoleId, modRoleId, memberRoleId, everyoneRoleId] });
    // @everyone in the list shifts the size mismatch check first.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/roles changed since this list was loaded/i);
  });

  it('rejects 409 when a role ID is missing', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, founderRoleId, modRoleId] }); // missing Member
    expect(res.status).toBe(409);
  });

  it('rejects 400 on duplicate IDs in the list', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, adminRoleId, founderRoleId, modRoleId, memberRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  it('Admin (pos 1) cannot move a role at or above their own position', async () => {
    // Admin tries to move Owner (pos 0) — already protected by "Owner at index 0",
    // so test the case where Admin tries to bump Admin role position itself.
    // Admin at pos 1, attempting to move Admin role to index 0 — would put
    // their own role above Owner; rejected first by Owner-at-top check.
    // Instead: try moving Founder (pos 2) into pos 1, knocking Admin below it.
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(admin.token))
      .send({ orderedRoleIds: [ownerRoleId, founderRoleId, adminRoleId, modRoleId, memberRoleId] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/at or above your own position/i);
  });

  it('Admin (pos 1) cannot move themselves above Owner (Owner-pin enforced first)', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(admin.token))
      .send({ orderedRoleIds: [adminRoleId, ownerRoleId, founderRoleId, modRoleId, memberRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner must remain at the top/i);
  });

  it('Admin CAN reorder roles strictly below their own position', async () => {
    // Admin (pos 1) reorders Founder/Mod/Member among themselves.
    const newOrder = [ownerRoleId, adminRoleId, memberRoleId, modRoleId, founderRoleId];
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(admin.token))
      .send({ orderedRoleIds: newOrder });
    expect(res.status).toBe(200);
    const after = await getRolesByPosition();
    expect(after.map((r) => r.name)).toEqual(['Owner', 'Admin', 'Member', 'Mod', 'Founder', '@everyone']);

    // Restore.
    await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(owner.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, founderRoleId, modRoleId, memberRoleId] })
      .expect(200);
  });

  it('Mod (pos 3, has manageRoles) cannot move roles at or above their position', async () => {
    // Mod tries to swap Founder (pos 2) and Mod (pos 3) — Founder is at-or-above mod.
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(modUser.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, modRoleId, founderRoleId, memberRoleId] });
    expect(res.status).toBe(403);
  });

  it('caller without manageRoles permission gets 403', async () => {
    const noPermUser = await createTestUser();
    await joinServer(noPermUser, [memberRoleId]);
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(noPermUser.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, founderRoleId, modRoleId, memberRoleId] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage roles/i);
  });

  it('non-member gets 403', async () => {
    const stranger = await createTestUser();
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/reorder`)
      .set('Authorization', authHeader(stranger.token))
      .send({ orderedRoleIds: [ownerRoleId, adminRoleId, founderRoleId, modRoleId, memberRoleId] });
    expect(res.status).toBe(403);
  });
});
