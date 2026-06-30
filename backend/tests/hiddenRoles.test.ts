// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { canSeeHiddenRoles } from '../src/utils/permissions.js';
import { emitRoleEventToMods } from '../src/utils/roleEmit.js';
import { createTestUser, createTestServer, authHeader } from './helpers.js';
describe('canSeeHiddenRoles', () => {
  const everyone = { id: 'e1', position: 999, permissions: {}, isEveryone: true };
  it('owner sees hidden roles', () => {
    expect(canSeeHiddenRoles({ member: { userId: 'u', role: 'owner' }, roles: [], everyoneRole: everyone })).toBe(true);
  });
  it('administrator sees hidden roles', () => {
    expect(canSeeHiddenRoles({ member: { userId: 'u', role: 'member' }, roles: [{ id: 'a', position: 2, permissions: { administrator: true } }], everyoneRole: everyone })).toBe(true);
  });
  it('manageRoles holder sees hidden roles', () => {
    expect(canSeeHiddenRoles({ member: { userId: 'u', role: 'member' }, roles: [{ id: 'm', position: 5, permissions: { manageRoles: true } }], everyoneRole: everyone })).toBe(true);
  });
  it('plain member does NOT see hidden roles', () => {
    expect(canSeeHiddenRoles({ member: { userId: 'u', role: 'member' }, roles: [{ id: 'r', position: 5, permissions: { sendMessages: true } }], everyoneRole: everyone })).toBe(false);
  });
});

describe('ServerRole.hidden persistence', () => {
  it('owner can create a role with hidden:true and it persists/returns', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const res = await request(app).post(`/api/servers/${server.id}/roles`).set('Authorization', authHeader(owner.token))
      .send({ name: 'Staff', color: '#ff0000', hidden: true });
    expect(res.status).toBe(201);
    expect(res.body.hidden).toBe(true);
    const row = await prisma.serverRole.findUnique({ where: { id: res.body.id } });
    expect(row?.hidden).toBe(true);
  });
});

describe('GET /roles hidden filtering', () => {
  it('GET /roles omits hidden roles for non-mods, includes for mods', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } } });
    const hiddenRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Staff', position: 5, hidden: true, permissions: {} } });
    const modRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Mod', position: 2, permissions: { manageRoles: true } } });
    const plain = await createTestUser();
    await prisma.serverMember.create({ data: { userId: plain.id, serverId: server.id, role: 'member' } });
    const mod = await createTestUser();
    await prisma.serverMember.create({ data: { userId: mod.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: mod.id, serverId: server.id, roleId: modRole.id } });
    const plainRes = await request(app).get(`/api/servers/${server.id}/roles`).set('Authorization', authHeader(plain.token));
    expect(plainRes.body.some((r: any) => r.id === hiddenRole.id)).toBe(false);
    const modRes = await request(app).get(`/api/servers/${server.id}/roles`).set('Authorization', authHeader(mod.token));
    expect(modRes.body.find((r: any) => r.id === hiddenRole.id)?.hidden).toBe(true);
  });
});

describe('GET /:serverId/members hidden role filtering', () => {
  it('member-list strips hidden role IDs + falls back display role for non-mods', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } } });
    const hiddenRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Staff', color: '#111111', position: 2, hidden: true, permissions: { kickMembers: true } } });
    const visibleRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Gamer', color: '#22ff22', position: 6, hidden: false, permissions: {} } });
    const target = await createTestUser();
    await prisma.serverMember.create({ data: { userId: target.id, serverId: server.id, role: 'Staff', roleId: hiddenRole.id } });
    await prisma.memberRole.create({ data: { userId: target.id, serverId: server.id, roleId: hiddenRole.id } });
    await prisma.memberRole.create({ data: { userId: target.id, serverId: server.id, roleId: visibleRole.id } });
    const viewer = await createTestUser();
    await prisma.serverMember.create({ data: { userId: viewer.id, serverId: server.id, role: 'member' } });
    const res = await request(app).get(`/api/servers/${server.id}/members?limit=500`).set('Authorization', authHeader(viewer.token));
    const row = res.body.members.find((m: any) => m.id === target.id);
    expect(row.roles.some((r: any) => r.id === hiddenRole.id)).toBe(false);
    expect(row.roles.some((r: any) => r.id === visibleRole.id)).toBe(true);
    expect(row.role).toBe('Gamer');
    expect(row.roleColor).toBe('#22ff22');
    // Mention-typeahead source guard: the role autocomplete is built client-side
    // from `users.map(u => u.role)` over this very member-list payload, so no row
    // may surface the hidden role name (display field) or its id (roles[]) for a
    // non-mod. Assert it holds for EVERY returned member, not just the target.
    res.body.members.forEach((m: any) => {
      expect(m.role).not.toBe('Staff');
      expect(m.roles.some((r: any) => r.id === hiddenRole.id)).toBe(false);
    });
  });
});

describe('GET /servers myRoles hidden filtering', () => {
  it('non-mod myRoles omits hidden roles but myPermissions keeps their perms', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } } });
    const hiddenRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Staff', position: 5, hidden: true, permissions: { kickMembers: true } } });
    const u = await createTestUser();
    await prisma.serverMember.create({ data: { userId: u.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: u.id, serverId: server.id, roleId: hiddenRole.id } });
    const res = await request(app).get('/api/servers').set('Authorization', authHeader(u.token));
    const srv = res.body.find((s: any) => s.id === server.id);
    expect(srv.myRoles.some((r: any) => r.id === hiddenRole.id)).toBe(false);
    expect(srv.myPermissions.kickMembers).toBe(true);
  });
});

describe('emitRoleEventToMods', () => {
  it('emits a role event ONLY to currently-connected mods (manageRoles), not plain members', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } } });
    const modRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Mod', position: 2, permissions: { manageRoles: true } } });
    const mod = await createTestUser();
    await prisma.serverMember.create({ data: { userId: mod.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: mod.id, serverId: server.id, roleId: modRole.id } });
    const plain = await createTestUser();
    await prisma.serverMember.create({ data: { userId: plain.id, serverId: server.id, role: 'member' } });

    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const fakeIo: any = {
      in: () => ({ fetchSockets: async () => ([
        { rooms: new Set([`server:${server.id}`, `user:${mod.id}`]) },
        { rooms: new Set([`server:${server.id}`, `user:${plain.id}`]) },
      ]) }),
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    };

    await emitRoleEventToMods(fakeIo, server.id, 'server-role-created', { foo: 1 });
    expect(emitted).toEqual([{ room: `user:${mod.id}`, event: 'server-role-created', payload: { foo: 1 } }]);
  });
});
