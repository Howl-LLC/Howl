// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for the roles-subsystem ownership and guard invariants:
 * transfer-ownership moves the authoritative Server.ownerId, the
 * administrator-bearing Owner MemberRole, and the display columns as one
 * atomic unit; role removal enforces the same target-hierarchy guard as
 * assignment; locked roles cannot be assigned, removed, or renamed; and
 * self-service grant paths (the self-assignable flag, the role picker, and
 * channel overrides) can never hand out elevated permissions.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { loadPermissionContext, hasPermission, SELF_ASSIGN_FORBIDDEN_PERMS } from '../src/utils/permissions.js';
import { VALID_PERMISSIONS } from '../src/schemas.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

/** Create the locked, administrator-bearing Owner role and give it to `ownerId`
 *  via the MemberRole join table — mirroring how production seeds an owner. */
async function seedOwnerRole(serverId: string, ownerId: string) {
  const ownerRole = await prisma.serverRole.create({
    data: {
      serverId, name: 'Owner', color: '#f59e0b', style: 'solid',
      position: 0, locked: true, displaySeparately: true,
      permissions: { administrator: true },
    },
  });
  await prisma.serverRole.create({
    data: { serverId, name: 'Member', color: '#06b6d4', style: 'solid', position: 1, permissions: {} },
  });
  await prisma.serverRole.create({
    data: { serverId, name: '@everyone', color: '#99aab5', style: 'solid', position: 999, locked: true, isEveryone: true, permissions: { viewChannels: true } },
  });
  await prisma.serverMember.update({ where: { userId_serverId: { userId: ownerId, serverId } }, data: { roleId: ownerRole.id } });
  await prisma.memberRole.create({ data: { userId: ownerId, serverId, roleId: ownerRole.id } });
  return ownerRole;
}

async function joinAs(serverId: string, userId: string, roleIds: string[] = []) {
  await prisma.serverMember.create({
    data: { userId, serverId, role: 'member', roleId: roleIds[0] ?? null },
  });
  for (const roleId of roleIds) {
    await prisma.memberRole.create({ data: { userId, serverId, roleId } });
  }
}

afterAll(async () => { await cleanupTestData(); });

describe('transfer-ownership', () => {
  let owner: TestUser, newOwner: TestUser, serverId: string, ownerRoleId: string;

  beforeEach(async () => {
    owner = await createTestUser();
    newOwner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    ownerRoleId = (await seedOwnerRole(serverId, owner.id)).id;
    await joinAs(serverId, newOwner.id);
  });

  it('moves ownerId, moves the Owner role, and strips the old owner of administrator', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/transfer-ownership`)
      .set('Authorization', authHeader(owner.token))
      .send({ newOwnerId: newOwner.id });
    expect(res.status).toBe(200);

    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
    expect(server?.ownerId).toBe(newOwner.id);

    // Old owner no longer holds the Owner MemberRole → no administrator.
    const oldOwnerRole = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: owner.id, serverId, roleId: ownerRoleId } },
    });
    expect(oldOwnerRole).toBeNull();

    const oldCtx = await loadPermissionContext(owner.id, serverId);
    expect(oldCtx?.isOwner).toBe(false);
    expect(hasPermission(oldCtx, 'administrator')).toBe(false);
    expect(hasPermission(oldCtx, 'manageServer')).toBe(false);

    // New owner is authoritative and holds the Owner role.
    const newOwnerRole = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: newOwner.id, serverId, roleId: ownerRoleId } },
    });
    expect(newOwnerRole).not.toBeNull();
    const newCtx = await loadPermissionContext(newOwner.id, serverId);
    expect(newCtx?.isOwner).toBe(true);
    expect(hasPermission(newCtx, 'administrator')).toBe(true);
  });

  it("the new owner's ownership survives a later role assignment", async () => {
    await request(app)
      .post(`/api/servers/${serverId}/transfer-ownership`)
      .set('Authorization', authHeader(owner.token))
      .send({ newOwnerId: newOwner.id })
      .expect(200);

    // Give the new owner an extra cosmetic role, which triggers a display-role
    // recompute. Ownership must not drift.
    const cosmetic = await prisma.serverRole.create({
      data: { serverId, name: 'VIP', color: '#abcdef', style: 'solid', position: 5, permissions: {} },
    });
    await request(app)
      .post(`/api/servers/${serverId}/roles/${cosmetic.id}/members`)
      .set('Authorization', authHeader(newOwner.token))
      .send({ userId: newOwner.id })
      .expect(200);

    const member = await prisma.serverMember.findUnique({ where: { userId_serverId: { userId: newOwner.id, serverId } }, select: { role: true } });
    expect(member?.role?.toLowerCase()).toBe('owner');
    const ctx = await loadPermissionContext(newOwner.id, serverId);
    expect(ctx?.isOwner).toBe(true);
  });

  it('rejects a non-owner attempting the transfer', async () => {
    await request(app)
      .post(`/api/servers/${serverId}/transfer-ownership`)
      .set('Authorization', authHeader(newOwner.token))
      .send({ newOwnerId: newOwner.id })
      .expect(403);
  });
});

describe('role removal hierarchy guard', () => {
  let owner: TestUser, mod: TestUser, victim: TestUser, serverId: string;
  let modRoleId: string, highRoleId: string, lowRoleId: string;

  beforeEach(async () => {
    owner = await createTestUser();
    mod = await createTestUser();
    victim = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    await seedOwnerRole(serverId, owner.id);

    const modRole = await prisma.serverRole.create({ data: { serverId, name: 'Mod', color: '#00f', style: 'solid', position: 5, permissions: { manageRoles: true } } });
    const highRole = await prisma.serverRole.create({ data: { serverId, name: 'Senior', color: '#0f0', style: 'solid', position: 2, permissions: {} } });
    const lowRole = await prisma.serverRole.create({ data: { serverId, name: 'Low', color: '#f00', style: 'solid', position: 8, permissions: {} } });
    modRoleId = modRole.id; highRoleId = highRole.id; lowRoleId = lowRole.id;

    await joinAs(serverId, mod.id, [modRoleId]);
    // Victim outranks the mod (Senior pos 2 < Mod pos 5) but also holds a Low role below the mod.
    await joinAs(serverId, victim.id, [highRoleId, lowRoleId]);
  });

  it('blocks a mod from removing a below-them role from a member who outranks them', async () => {
    const res = await request(app)
      .delete(`/api/servers/${serverId}/roles/${lowRoleId}/members/${victim.id}`)
      .set('Authorization', authHeader(mod.token));
    expect(res.status).toBe(403);
    // The role is still assigned.
    const still = await prisma.memberRole.findUnique({ where: { userId_serverId_roleId: { userId: victim.id, serverId, roleId: lowRoleId } } });
    expect(still).not.toBeNull();
  });

  it('blocks a mod from removing any role from the owner', async () => {
    // Give the owner a low cosmetic role, then have the mod try to strip it.
    await prisma.memberRole.create({ data: { userId: owner.id, serverId, roleId: lowRoleId } });
    const res = await request(app)
      .delete(`/api/servers/${serverId}/roles/${lowRoleId}/members/${owner.id}`)
      .set('Authorization', authHeader(mod.token));
    expect(res.status).toBe(403);
  });

  it('still allows removing a below-them role from a member who does NOT outrank them', async () => {
    const junior = await createTestUser();
    await joinAs(serverId, junior.id, [lowRoleId]);
    await request(app)
      .delete(`/api/servers/${serverId}/roles/${lowRoleId}/members/${junior.id}`)
      .set('Authorization', authHeader(mod.token))
      .expect(200);
    await cleanupUser(junior.id);
  });
});

describe('locked-role assignment + rename guards', () => {
  let owner: TestUser, other: TestUser, serverId: string, ownerRoleId: string;

  beforeEach(async () => {
    owner = await createTestUser();
    other = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    ownerRoleId = (await seedOwnerRole(serverId, owner.id)).id;
    await joinAs(serverId, other.id);
  });

  it('refuses to assign the locked Owner role via role assignment', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles/${ownerRoleId}/members`)
      .set('Authorization', authHeader(owner.token))
      .send({ userId: other.id });
    expect(res.status).toBe(400);
    // No co-owner minted.
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
    expect(server?.ownerId).toBe(owner.id);
  });

  it('refuses to rename the locked Owner role', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/roles/${ownerRoleId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'Founder' });
    expect(res.status).toBe(400);
    const role = await prisma.serverRole.findUnique({ where: { id: ownerRoleId }, select: { name: true } });
    expect(role?.name).toBe('Owner');
  });
});

describe('self-assignable permission backstop', () => {
  let owner: TestUser, serverId: string;

  beforeEach(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    await seedOwnerRole(serverId, owner.id);
  });

  it('refuses to create a self-assignable role that carries an elevated permission', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'Sneaky', color: '#123456', selfAssignable: true, permissions: { kickMembers: true } });
    expect(res.status).toBe(400);
  });

  it('allows a self-assignable cosmetic role (no elevated permissions)', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'Pronouns', color: '#123456', selfAssignable: true, permissions: { changeNickname: true } });
    expect(res.status).toBe(201);
  });

  it('refuses to add an elevated permission to an already self-assignable role', async () => {
    const role = await prisma.serverRole.create({ data: { serverId, name: 'Cosmetic', color: '#222', style: 'solid', position: 5, selfAssignable: true, permissions: {} } });
    const res = await request(app)
      .put(`/api/servers/${serverId}/roles/${role.id}`)
      .set('Authorization', authHeader(owner.token))
      .send({ permissions: { banMembers: true } });
    expect(res.status).toBe(400);
  });
});


describe('transfer-ownership resilience', () => {
  it('still moves the locked Owner role even if it was renamed in the database', async () => {
    const owner = await createTestUser();
    const heir = await createTestUser();
    const server = await createTestServer(owner.id);
    const ownerRoleId = (await seedOwnerRole(server.id, owner.id)).id;
    await joinAs(server.id, heir.id);
    // Simulate a legacy server whose locked role was renamed before the
    // rename guard existed. The transfer must find it via the locked flag.
    await prisma.serverRole.update({ where: { id: ownerRoleId }, data: { name: 'Founder' } });

    await request(app)
      .post(`/api/servers/${server.id}/transfer-ownership`)
      .set('Authorization', authHeader(owner.token))
      .send({ newOwnerId: heir.id })
      .expect(200);

    const heirRole = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: heir.id, serverId: server.id, roleId: ownerRoleId } },
    });
    expect(heirRole).not.toBeNull();
    const oldRole = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: owner.id, serverId: server.id, roleId: ownerRoleId } },
    });
    expect(oldRole).toBeNull();
  });

  it('authorizes via the legacy role string and heals ownerId when it was never backfilled', async () => {
    const owner = await createTestUser();
    const heir = await createTestUser();
    // Legacy server shape: no ownerId, owner-ness only in the role string.
    const server = await prisma.server.create({
      data: {
        name: `Legacy ${Date.now()}`,
        members: { create: { userId: owner.id, role: 'owner' } },
      },
    });
    await seedOwnerRole(server.id, owner.id);
    await joinAs(server.id, heir.id);

    await request(app)
      .post(`/api/servers/${server.id}/transfer-ownership`)
      .set('Authorization', authHeader(owner.token))
      .send({ newOwnerId: heir.id })
      .expect(200);

    const healed = await prisma.server.findUnique({ where: { id: server.id }, select: { ownerId: true } });
    expect(healed?.ownerId).toBe(heir.id);
  });
});

describe('role picker elevated-permission backstop', () => {
  let owner: TestUser, member: TestUser, serverId: string;
  let pickerId: string, categoryId: string;

  beforeEach(async () => {
    owner = await createTestUser();
    member = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    await seedOwnerRole(serverId, owner.id);
    await joinAs(serverId, member.id);

    const ch = await request(app)
      .post(`/api/v1/servers/${serverId}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'pick-roles', type: 'role_picker' });
    expect(ch.status).toBe(201);
    const picker = await prisma.rolePickerChannel.findUnique({ where: { serverId } });
    pickerId = picker!.id;
    const cat = await prisma.rolePickerCategory.create({ data: { pickerId, name: 'Roles', position: 0 } });
    categoryId = cat.id;
  });

  it('refuses to claim an entry whose role carries elevated base permissions', async () => {
    // Legacy shape: the role predates the create/update guards.
    const rogue = await prisma.serverRole.create({
      data: { serverId, name: 'LegacyMod', color: '#111', style: 'solid', position: 5, selfAssignable: true, permissions: { manageMessages: true } },
    });
    const entry = await prisma.rolePickerEntry.create({ data: { categoryId, roleId: rogue.id, position: 0 } });

    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entry.id}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(400);
    const granted = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: member.id, serverId, roleId: rogue.id } },
    });
    expect(granted).toBeNull();
  });

  it('refuses to claim an entry whose role carries an elevated channel override', async () => {
    const cosmetic = await prisma.serverRole.create({
      data: { serverId, name: 'Cosmetic', color: '#222', style: 'solid', position: 6, selfAssignable: true, permissions: {} },
    });
    const ch = await request(app)
      .post(`/api/v1/servers/${serverId}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'general-2', type: 'text' });
    expect(ch.status).toBe(201);
    await prisma.channelPermissionOverride.create({
      data: { channelId: ch.body.id, targetType: 'role', targetId: cosmetic.id, permissions: { manageMessages: true } },
    });
    const entry = await prisma.rolePickerEntry.create({ data: { categoryId, roleId: cosmetic.id, position: 1 } });

    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entry.id}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(400);
  });

  it('still allows claiming a purely cosmetic role', async () => {
    const pronouns = await prisma.serverRole.create({
      data: { serverId, name: 'He/Him', color: '#333', style: 'solid', position: 7, selfAssignable: true, permissions: {} },
    });
    const entry = await prisma.rolePickerEntry.create({ data: { categoryId, roleId: pronouns.id, position: 2 } });

    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entry.id}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(200);
    const granted = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: member.id, serverId, roleId: pronouns.id } },
    });
    expect(granted).not.toBeNull();
  });

  it('refuses to add an entry for a role with elevated permissions', async () => {
    const rogue = await prisma.serverRole.create({
      data: { serverId, name: 'LegacyMod2', color: '#444', style: 'solid', position: 8, selfAssignable: true, permissions: { kickMembers: true } },
    });
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories/${categoryId}/entries`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleId: rogue.id });
    expect(res.status).toBe(400);
  });

  it('refuses a channel override that grants elevated permissions to a self-assignable role', async () => {
    const cosmetic = await prisma.serverRole.create({
      data: { serverId, name: 'Cosmetic2', color: '#555', style: 'solid', position: 9, selfAssignable: true, permissions: {} },
    });
    const ch = await request(app)
      .post(`/api/v1/servers/${serverId}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'general-3', type: 'text' });
    expect(ch.status).toBe(201);
    const res = await request(app)
      .put(`/api/v1/servers/${serverId}/channels/${ch.body.id}/permissions`)
      .set('Authorization', authHeader(owner.token))
      .send({ targetType: 'role', targetId: cosmetic.id, permissions: { manageMessages: true } });
    expect(res.status).toBe(400);
  });
});

describe('account-deletion ownership succession', () => {
  it('hands the server to the earliest member with full owner authority', async () => {
    const owner = await createTestUser();
    const heir = await createTestUser();
    const server = await createTestServer(owner.id);
    const ownerRoleId = (await seedOwnerRole(server.id, owner.id)).id;
    await joinAs(server.id, heir.id);

    const res = await request(app)
      .post('/api/v1/gdpr/delete')
      .set('Authorization', authHeader(owner.token))
      .send({ password: 'TestPass123!' });
    expect(res.status).toBe(200);

    const row = await prisma.server.findUnique({ where: { id: server.id }, select: { ownerId: true } });
    expect(row?.ownerId).toBe(heir.id);

    // The successor holds the administrator-bearing Owner MemberRole and is
    // authoritative — not just a display string.
    const heirOwnerRole = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: heir.id, serverId: server.id, roleId: ownerRoleId } },
    });
    expect(heirOwnerRole).not.toBeNull();
    const ctx = await loadPermissionContext(heir.id, server.id);
    expect(ctx?.isOwner).toBe(true);
    expect(hasPermission(ctx, 'administrator')).toBe(true);
  });
});

describe('self-assign permission classification', () => {
  // Every permission must be explicitly classified. When a new permission is
  // added to VALID_PERMISSIONS, this test forces a decision: is it elevated
  // (self-service grant paths must refuse it) or cosmetic/self-scoped?
  const SELF_ASSIGN_ALLOWED = new Set<string>([
    'createInvite', 'changeNickname', 'sendMessages', 'sendMessagesInThreads',
    'embedLinks', 'attachFiles', 'addReactions', 'readMessageHistory',
    'connect', 'speak', 'video', 'useVoiceActivity', 'viewChannels',
    'createExpressions', 'viewCalendar', 'createPolls', 'createThreads',
    'requestToSpeak', 'createPublicThreads', 'createPrivateThreads',
    'useExternalEmoji', 'useExternalStickers', 'useExternalSounds',
    'useSoundboard', 'createPosts', 'sendMessagesInPosts', 'createEvents',
  ]);

  it('classifies every permission as either forbidden or allowed for self-assign', () => {
    for (const perm of VALID_PERMISSIONS) {
      const forbidden = SELF_ASSIGN_FORBIDDEN_PERMS.has(perm);
      const allowed = SELF_ASSIGN_ALLOWED.has(perm);
      expect(forbidden || allowed, `unclassified permission: ${perm}`).toBe(true);
      expect(forbidden && allowed, `doubly-classified permission: ${perm}`).toBe(false);
    }
    for (const perm of SELF_ASSIGN_FORBIDDEN_PERMS) {
      expect((VALID_PERMISSIONS as readonly string[]).includes(perm), `stale forbidden permission: ${perm}`).toBe(true);
    }
  });
});

/** Remove a single test user's memberships/rows without wiping the whole DB. */
async function cleanupUser(userId: string) {
  await prisma.memberRole.deleteMany({ where: { userId } });
  await prisma.serverMember.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}
