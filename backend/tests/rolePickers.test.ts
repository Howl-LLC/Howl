// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Self Roles — backend integration tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

describe('Self Roles backend', () => {
  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let serverId: string;
  let pickerChannelId: string;
  let pickerId: string;
  let categoryId: string;
  let entryId: string;
  let roleId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    member = await createTestUser();
    stranger = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;

    // Add member to server (no special roles).
    await prisma.serverMember.create({ data: { serverId, userId: member.id, role: 'member' } });

    // Add an @everyone baseline role so loadPermissionContext returns a context for non-owners.
    await prisma.serverRole.create({
      data: { serverId, name: '@everyone', color: '#99aab5', position: 999, isEveryone: true,
        permissions: { sendMessages: true, viewChannels: true, readMessageHistory: true, embedLinks: true } as never,
      },
    });

    // Create a self-assignable role for tests
    const role = await prisma.serverRole.create({
      data: { serverId, name: 'Valorant', color: '#fbbf24', position: 5, selfAssignable: true, permissions: {} as never },
    });
    roleId = role.id;

    // Create the picker channel via the API to exercise the auto-create path.
    const ch = await request(app)
      .post(`/api/v1/servers/${serverId}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'pick-roles', type: 'role_picker' });
    expect(ch.status).toBe(201);
    pickerChannelId = ch.body.id;

    // Look up the auto-created picker
    const picker = await prisma.rolePickerChannel.findUnique({ where: { serverId } });
    expect(picker).not.toBeNull();
    pickerId = picker!.id;

    // Create one category + one entry directly (will exercise category/entry routes in their own tests).
    const cat = await prisma.rolePickerCategory.create({
      data: { pickerId, name: 'Game roles', position: 0, pickMode: 'multi' },
    });
    categoryId = cat.id;
    const entry = await prisma.rolePickerEntry.create({
      data: { categoryId: cat.id, roleId, position: 0, emoji: '🎮', description: 'Ranked nights' },
    });
    entryId = entry.id;
  });

  afterAll(cleanupTestData);

  // GET routes

  it('GET /role-pickers — returns server\'s single picker', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.picker).toMatchObject({ id: pickerId, channelId: pickerChannelId });
  });

  it('GET /role-pickers — returns picker:null on a fresh server', async () => {
    const owner2 = await createTestUser();
    const s2 = await createTestServer(owner2.id);
    try {
      const res = await request(app)
        .get(`/api/v1/servers/${s2.id}/role-pickers`)
        .set('Authorization', authHeader(owner2.token));
      expect(res.status).toBe(200);
      expect(res.body.picker).toBeNull();
    } finally {
      await prisma.server.delete({ where: { id: s2.id } });
      await prisma.user.delete({ where: { id: owner2.id } });
    }
  });

  it('GET /role-pickers — non-member 403', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers`)
      .set('Authorization', authHeader(stranger.token));
    expect(res.status).toBe(403);
  });

  it('GET /role-pickers/:pickerId — full tree with categories + entries + held state', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(pickerId);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].entries).toHaveLength(1);
    expect(res.body.categories[0].entries[0]).toMatchObject({
      emoji: '🎮',
      description: 'Ranked nights',
      held: false,
      pending: false,
      role: expect.objectContaining({ name: 'Valorant', selfAssignable: true }),
    });
  });

  // Channel-create extension

  it('POST /channels with type=role_picker — second one returns 409', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'second-picker', type: 'role_picker' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      existingChannelId: pickerChannelId,
    });
  });

  // Picker hero PATCH

  it('PATCH /role-pickers/:pickerId — owner can update hero', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ heroTitle: 'Pick yours', heroDescription: 'Custom desc' });
    expect(res.status).toBe(200);
    expect(res.body.heroTitle).toBe('Pick yours');
  });

  it('PATCH /role-pickers/:pickerId — non-manageRoles user 403', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
      .set('Authorization', authHeader(member.token))
      .send({ heroTitle: 'Hijack' });
    expect(res.status).toBe(403);
  });

  // Categories

  it('POST /role-pickers/:pickerId/categories — creates category', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'Notifications', pickMode: 'multi' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Notifications');
    expect(res.body.position).toBeGreaterThanOrEqual(1);
    // Cleanup so other tests aren't affected
    await prisma.rolePickerCategory.delete({ where: { id: res.body.id } });
  });

  // Entries

  it('POST entries — rejects role with selfAssignable=false', async () => {
    const nonSelf = await prisma.serverRole.create({
      data: { serverId, name: 'Mod', color: '#fff', position: 6, selfAssignable: false, permissions: {} as never },
    });
    try {
      const res = await request(app)
        .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories/${categoryId}/entries`)
        .set('Authorization', authHeader(owner.token))
        .send({ roleId: nonSelf.id });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('self-assignable');
    } finally {
      await prisma.serverRole.delete({ where: { id: nonSelf.id } });
    }
  });

  it('POST entries — duplicate role in same category 409', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/categories/${categoryId}/entries`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleId });
    expect(res.status).toBe(409);
  });

  it('PATCH entries/:id — admin can update emoji/description/requirements', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ description: 'Updated desc', requirements: { tenureDays: 7 } });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Updated desc');
    expect(res.body.requirements).toMatchObject({ tenureDays: 7 });
  });

  // Self-claim

  it('POST claim — fails 422 when conditions unmet (tenure)', async () => {
    // Set requirements to require 100 days of tenure (member just joined)
    await prisma.rolePickerEntry.update({
      where: { id: entryId },
      data: { requirements: { tenureDays: 100 } as never },
    });
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(422);
    expect(res.body.failed[0]).toMatchObject({ kind: 'tenure', required: 100 });
  });

  it('POST claim — succeeds when conditions met', async () => {
    await prisma.rolePickerEntry.update({
      where: { id: entryId },
      data: { requirements: null },
    });
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('granted');
    const mr = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: member.id, serverId, roleId } },
    });
    expect(mr).not.toBeNull();
  });

  it('POST claim — idempotent when already held', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_held');
  });

  it('DELETE claim — releases the role', async () => {
    const res = await request(app)
      .delete(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(200);
    expect(res.body.removed).toBeGreaterThanOrEqual(1);
    const mr = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: member.id, serverId, roleId } },
    });
    expect(mr).toBeNull();
  });

  it('POST claim — manualApproval routes to queue (202)', async () => {
    await prisma.rolePickerEntry.update({
      where: { id: entryId },
      data: { requirements: { manualApproval: true } as never },
    });
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_approval');
    expect(res.body.requestId).toBeTruthy();
    // No role granted yet
    const mr = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: member.id, serverId, roleId } },
    });
    expect(mr).toBeNull();
  });

  it('POST claim — duplicate pending request 409', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(409);
  });

  // Approvals queue

  it('GET requests/list — admin sees pending request', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers/requests/list?status=pending`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.requests.length).toBeGreaterThanOrEqual(1);
    expect(res.body.requests[0]).toMatchObject({
      status: 'pending',
      role: expect.objectContaining({ name: 'Valorant' }),
    });
  });

  it('GET requests/list — non-manageRoles 403', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers/requests/list`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(403);
  });

  it('PATCH requests/:id/decide — approve grants role', async () => {
    const reqs = await prisma.roleClaimRequest.findMany({
      where: { serverId, userId: member.id, status: 'pending' },
    });
    expect(reqs.length).toBe(1);
    const reqId = reqs[0].id;
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/role-pickers/requests/${reqId}/decide`)
      .set('Authorization', authHeader(owner.token))
      .send({ decision: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    const mr = await prisma.memberRole.findUnique({
      where: { userId_serverId_roleId: { userId: member.id, serverId, roleId } },
    });
    expect(mr).not.toBeNull();
  });

  it('PATCH requests/:id/decide — already-decided returns 409', async () => {
    const reqs = await prisma.roleClaimRequest.findMany({
      where: { serverId, status: 'approved' },
    });
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    const reqId = reqs[0].id;
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/role-pickers/requests/${reqId}/decide`)
      .set('Authorization', authHeader(owner.token))
      .send({ decision: 'reject' });
    expect(res.status).toBe(409);
  });

  it('POST claim — 403 when member holds a blocksSelfRoles role', async () => {
    await prisma.rolePickerEntry.update({ where: { id: entryId }, data: { requirements: null } });
    const blocker = await prisma.serverRole.create({ data: { serverId, name: 'Muted', color: '#555', position: 6, blocksSelfRoles: true, permissions: {} as never } });
    await prisma.memberRole.create({ data: { userId: member.id, serverId, roleId: blocker.id } });
    try {
      const res = await request(app).post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`).set('Authorization', authHeader(member.token));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/restricted from claiming/i);
      const still = await prisma.memberRole.findUnique({ where: { userId_serverId_roleId: { userId: member.id, serverId, roleId: blocker.id } } });
      expect(still).not.toBeNull();
    } finally {
      await prisma.memberRole.deleteMany({ where: { serverId, roleId: blocker.id } });
      await prisma.serverRole.delete({ where: { id: blocker.id } });
    }
  });

  it('POST request — 403 when member holds a blocksSelfRoles role', async () => {
    await prisma.rolePickerEntry.update({ where: { id: entryId }, data: { requirements: { manualApproval: true } as never } });
    const blocker = await prisma.serverRole.create({ data: { serverId, name: 'Muted2', color: '#555', position: 7, blocksSelfRoles: true, permissions: {} as never } });
    await prisma.memberRole.create({ data: { userId: member.id, serverId, roleId: blocker.id } });
    try {
      const res = await request(app).post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/request`).set('Authorization', authHeader(member.token)).send({ applicantMessage: 'pls' });
      expect(res.status).toBe(403);
    } finally {
      await prisma.memberRole.deleteMany({ where: { serverId, roleId: blocker.id } });
      await prisma.serverRole.delete({ where: { id: blocker.id } });
    }
  });

  it('PATCH decide approve — 403 when applicant became blocked after requesting', async () => {
    await prisma.rolePickerEntry.update({ where: { id: entryId }, data: { requirements: { manualApproval: true } as never } });
    await prisma.serverMember.upsert({ where: { userId_serverId: { userId: stranger.id, serverId } }, create: { serverId, userId: stranger.id, role: 'member' }, update: {} });
    const reqRow = await prisma.roleClaimRequest.create({ data: { serverId, userId: stranger.id, pickerEntryId: entryId, roleId, status: 'pending' } });
    const blocker = await prisma.serverRole.create({ data: { serverId, name: 'Muted3', color: '#555', position: 8, blocksSelfRoles: true, permissions: {} as never } });
    await prisma.memberRole.create({ data: { userId: stranger.id, serverId, roleId: blocker.id } });
    try {
      const res = await request(app).patch(`/api/v1/servers/${serverId}/role-pickers/requests/${reqRow.id}/decide`).set('Authorization', authHeader(owner.token)).send({ decision: 'approve' });
      expect(res.status).toBe(403);
      expect(await prisma.memberRole.findUnique({ where: { userId_serverId_roleId: { userId: stranger.id, serverId, roleId } } })).toBeNull();
      expect((await prisma.roleClaimRequest.findUnique({ where: { id: reqRow.id } }))?.status).toBe('pending');
    } finally {
      await prisma.memberRole.deleteMany({ where: { serverId, roleId: blocker.id } });
      await prisma.serverRole.delete({ where: { id: blocker.id } });
      await prisma.roleClaimRequest.delete({ where: { id: reqRow.id } }).catch(() => {});
    }
  });

  it('GET /role-pickers/:pickerId — selfRolesBlocked flips false→true when a blocksSelfRoles role is granted to the viewer', async () => {
    const before = await request(app)
      .get(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
      .set('Authorization', authHeader(member.token));
    expect(before.status).toBe(200);
    expect(before.body.selfRolesBlocked).toBe(false);

    const blocker = await prisma.serverRole.create({ data: { serverId, name: 'MutedTree', color: '#555', position: 9, blocksSelfRoles: true, permissions: {} as never } });
    await prisma.memberRole.create({ data: { userId: member.id, serverId, roleId: blocker.id } });
    try {
      const after = await request(app)
        .get(`/api/v1/servers/${serverId}/role-pickers/${pickerId}`)
        .set('Authorization', authHeader(member.token));
      expect(after.status).toBe(200);
      expect(after.body.selfRolesBlocked).toBe(true);
    } finally {
      await prisma.memberRole.deleteMany({ where: { serverId, roleId: blocker.id } });
      await prisma.serverRole.delete({ where: { id: blocker.id } });
    }
  });

  // excludeRoleIds condition (schema + claim passthrough)

  it('POST claim — 422 excludedRole when member holds an excluded role', async () => {
    // Earlier tests may have granted the target role to `member`; the claim route
    // short-circuits "already_held" before evaluating conditions, so release it first.
    await prisma.memberRole.deleteMany({ where: { userId: member.id, serverId, roleId } });
    const excluded = await prisma.serverRole.create({ data: { serverId, name: 'Excluded', color: '#555', position: 10, permissions: {} as never } });
    await prisma.rolePickerEntry.update({ where: { id: entryId }, data: { requirements: { excludeRoleIds: [excluded.id] } as never } });
    await prisma.memberRole.create({ data: { userId: member.id, serverId, roleId: excluded.id } });
    try {
      const res = await request(app)
        .post(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}/claim`)
        .set('Authorization', authHeader(member.token));
      expect(res.status).toBe(422);
      expect(res.body.failed).toContainEqual({ kind: 'excludedRole', present: [excluded.id] });
      // Target role not granted
      const mr = await prisma.memberRole.findUnique({ where: { userId_serverId_roleId: { userId: member.id, serverId, roleId } } });
      expect(mr).toBeNull();
    } finally {
      await prisma.memberRole.deleteMany({ where: { serverId, roleId: excluded.id } });
      await prisma.serverRole.delete({ where: { id: excluded.id } });
      await prisma.rolePickerEntry.update({ where: { id: entryId }, data: { requirements: null } });
    }
  });

  it('PATCH entries/:id — schema accepts & persists requirements.excludeRoleIds', async () => {
    try {
      const res = await request(app)
        .patch(`/api/v1/servers/${serverId}/role-pickers/${pickerId}/entries/${entryId}`)
        .set('Authorization', authHeader(owner.token))
        .send({ requirements: { excludeRoleIds: [roleId] } });
      expect(res.status).toBe(200);
      expect(res.body.requirements).toMatchObject({ excludeRoleIds: [roleId] });
      // Round-trips through the DB, not just the response.
      const persisted = await prisma.rolePickerEntry.findUnique({ where: { id: entryId }, select: { requirements: true } });
      expect((persisted!.requirements as { excludeRoleIds?: string[] }).excludeRoleIds).toEqual([roleId]);
    } finally {
      await prisma.rolePickerEntry.update({ where: { id: entryId }, data: { requirements: null } });
    }
  });
});
