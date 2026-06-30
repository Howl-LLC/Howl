// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Hidden-role DISPLAY-metadata leak seams.
 *
 * GET /role-pickers/:pickerId tree must omit hidden self-assignable entries
 * for non-mod viewers (canSeeHiddenRoles false) while keeping them for mods.
 * emitMemberRoleEventScoped must send the FULL payload to mods and a
 * SANITIZED payload to non-mods (mirrors the emitRoleEventToMods test).
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { emitMemberRoleEventScoped } from '../src/utils/roleEmit.js';
import { createTestUser, createTestServer, authHeader } from './helpers.js';

describe('fetchPickerTree strips hidden entries for non-mods', () => {
  it('non-mod tree omits a hidden+selfAssignable entry; mod still sees it', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } as never } });
    const modRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Mod', position: 2, permissions: { manageRoles: true } as never } });

    // A hidden self-assignable role + a visible self-assignable role.
    const hiddenRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'SecretSquad', color: '#111111', position: 5, hidden: true, selfAssignable: true, permissions: {} as never } });
    const visibleRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Gamer', color: '#22ff22', position: 6, hidden: false, selfAssignable: true, permissions: {} as never } });

    // Picker channel (auto-creates the picker) + one category with both entries.
    const ch = await request(app)
      .post(`/api/v1/servers/${server.id}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'pick-roles', type: 'role_picker' });
    expect(ch.status).toBe(201);
    const picker = await prisma.rolePickerChannel.findUnique({ where: { serverId: server.id } });
    expect(picker).not.toBeNull();
    const cat = await prisma.rolePickerCategory.create({ data: { pickerId: picker!.id, name: 'Squads', position: 0, pickMode: 'multi' } });
    await prisma.rolePickerEntry.create({ data: { categoryId: cat.id, roleId: hiddenRole.id, position: 0 } });
    await prisma.rolePickerEntry.create({ data: { categoryId: cat.id, roleId: visibleRole.id, position: 1 } });

    const plain = await createTestUser();
    await prisma.serverMember.create({ data: { userId: plain.id, serverId: server.id, role: 'member' } });
    const mod = await createTestUser();
    await prisma.serverMember.create({ data: { userId: mod.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: mod.id, serverId: server.id, roleId: modRole.id } });

    // Non-mod: only the visible entry is present, hidden entry stripped, and the
    // hidden role's name/color/id never appear.
    const plainRes = await request(app)
      .get(`/api/v1/servers/${server.id}/role-pickers/${picker!.id}`)
      .set('Authorization', authHeader(plain.token));
    expect(plainRes.status).toBe(200);
    const plainEntries = plainRes.body.categories[0].entries;
    expect(plainEntries.map((e: any) => e.roleId)).toEqual([visibleRole.id]);
    expect(plainEntries.some((e: any) => e.role.id === hiddenRole.id)).toBe(false);
    expect(plainEntries.some((e: any) => e.role.name === 'SecretSquad')).toBe(false);
    // Wire shape unchanged — `hidden` is internal, never exposed.
    expect(plainEntries[0].role.hidden).toBeUndefined();

    // Mod: both entries present, including the hidden one.
    const modRes = await request(app)
      .get(`/api/v1/servers/${server.id}/role-pickers/${picker!.id}`)
      .set('Authorization', authHeader(mod.token));
    expect(modRes.status).toBe(200);
    const modEntries = modRes.body.categories[0].entries;
    expect(modEntries.map((e: any) => e.roleId).sort()).toEqual([hiddenRole.id, visibleRole.id].sort());
    expect(modEntries.some((e: any) => e.role.id === hiddenRole.id)).toBe(true);
    // Even for a mod, the wire shape stays unchanged (no `hidden` field).
    expect(modEntries[0].role.hidden).toBeUndefined();
  });
});

describe('emitMemberRoleEventScoped', () => {
  it('sends full payload to mods (manageRoles) and sanitized payload to non-mods', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } as never } });
    const modRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Mod', position: 2, permissions: { manageRoles: true } as never } });
    const mod = await createTestUser();
    await prisma.serverMember.create({ data: { userId: mod.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: mod.id, serverId: server.id, roleId: modRole.id } });
    const plain = await createTestUser();
    await prisma.serverMember.create({ data: { userId: plain.id, serverId: server.id, role: 'member' } });

    const emitted: Array<{ room: string; event: string; payload: any }> = [];
    const fakeIo: any = {
      in: () => ({ fetchSockets: async () => ([
        { rooms: new Set([`server:${server.id}`, `user:${mod.id}`]) },
        { rooms: new Set([`server:${server.id}`, `user:${plain.id}`]) },
      ]) }),
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    };

    const full = { serverId: server.id, userId: 'target', roleName: 'SecretSquad', roleColor: '#111111' };
    const sanitized = { serverId: server.id, userId: 'target', roleName: 'member', roleColor: '#99aab5' };

    await emitMemberRoleEventScoped(fakeIo, server.id, 'server-member-role-updated', { full, sanitized });

    // Exactly ONE emit per connected user — no double-emit.
    expect(emitted).toHaveLength(2);
    const modEmit = emitted.find((e) => e.room === `user:${mod.id}`);
    const plainEmit = emitted.find((e) => e.room === `user:${plain.id}`);
    expect(modEmit).toBeDefined();
    expect(plainEmit).toBeDefined();
    // Mod gets the full payload (hidden role name/color present).
    expect(modEmit!.payload).toEqual(full);
    expect(modEmit!.payload.roleName).toBe('SecretSquad');
    // Non-mod gets the sanitized payload (no hidden name/color).
    expect(plainEmit!.payload).toEqual(sanitized);
    expect(plainEmit!.payload.roleName).not.toBe('SecretSquad');
    expect(plainEmit!.payload.roleColor).not.toBe('#111111');
  });
});

describe('role-delete broadcast does not leak a still-held hidden role', () => {
  it('non-mod gets visible fallback display; mod gets the hidden display, on the role-delete member-role events', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({ data: { serverId: server.id, name: '@everyone', isEveryone: true, position: 999, permissions: { viewChannels: true } as never } });

    // A visible role that will be DELETED, and a hidden role the target keeps.
    const deletedRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Gamer', color: '#22ff22', position: 6, hidden: false, permissions: {} as never } });
    const hiddenRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'SecretSquad', color: '#111111', position: 5, hidden: true, permissions: {} as never } });

    // Target member holds BOTH the deleted role and the hidden role. After the
    // deletion, the hidden role becomes their display (higher position).
    const target = await createTestUser();
    await prisma.serverMember.create({ data: { userId: target.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: target.id, serverId: server.id, roleId: deletedRole.id } });
    await prisma.memberRole.create({ data: { userId: target.id, serverId: server.id, roleId: hiddenRole.id } });

    // A mod (manageRoles → canSeeHiddenRoles) and a plain non-mod, both connected.
    const modRole = await prisma.serverRole.create({ data: { serverId: server.id, name: 'Mod', position: 2, permissions: { manageRoles: true } as never } });
    const mod = await createTestUser();
    await prisma.serverMember.create({ data: { userId: mod.id, serverId: server.id, role: 'member' } });
    await prisma.memberRole.create({ data: { userId: mod.id, serverId: server.id, roleId: modRole.id } });
    const plain = await createTestUser();
    await prisma.serverMember.create({ data: { userId: plain.id, serverId: server.id, role: 'member' } });

    // Capture every emit + which room it targeted. fetchSockets returns one mod
    // and one non-mod connection so emitMemberRoleEventScoped can scope per-user.
    const emitted: Array<{ room: string; event: string; payload: any }> = [];
    const fakeIo: any = {
      in: () => ({ fetchSockets: async () => ([
        { rooms: new Set([`server:${server.id}`, `user:${mod.id}`]) },
        { rooms: new Set([`server:${server.id}`, `user:${plain.id}`]) },
      ]) }),
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    };

    const realIo = app.get('io');
    app.set('io', fakeIo);
    try {
      const res = await request(app)
        .delete(`/api/v1/servers/${server.id}/roles/${deletedRole.id}`)
        .set('Authorization', authHeader(owner.token));
      expect(res.status).toBe(200);
    } finally {
      app.set('io', realIo);
    }

    // The legacy compat display event for the target member, per recipient.
    const updates = emitted.filter(e => e.event === 'server-member-role-updated' && e.payload.userId === target.id);
    const modUpdate = updates.find(e => e.room === `user:${mod.id}`);
    const plainUpdate = updates.find(e => e.room === `user:${plain.id}`);
    expect(modUpdate).toBeDefined();
    expect(plainUpdate).toBeDefined();

    // Mod: sees the hidden role as the new display (full payload).
    expect(modUpdate!.payload.roleName).toBe('SecretSquad');
    expect(modUpdate!.payload.roleColor).toBe('#111111');

    // Non-mod: MUST NOT receive the hidden role's name/color — gets the fallback.
    expect(plainUpdate!.payload.roleName).not.toBe('SecretSquad');
    expect(plainUpdate!.payload.roleColor).not.toBe('#111111');
    expect(plainUpdate!.payload.roleName).toBe('member');
    expect(plainUpdate!.payload.roleColor).toBe('#99aab5');

    // And the hidden role id must not leak in the non-mod's roles[] on -removed.
    const removed = emitted.filter(e => e.event === 'server-member-role-removed' && e.payload.userId === target.id);
    const plainRemoved = removed.find(e => e.room === `user:${plain.id}`);
    const modRemoved = removed.find(e => e.room === `user:${mod.id}`);
    expect(plainRemoved).toBeDefined();
    expect(plainRemoved!.payload.roles).not.toContain(hiddenRole.id);
    expect(modRemoved!.payload.roles).toContain(hiddenRole.id);

    // No leaky whole-room broadcast of the target's member-role events when a
    // hidden role is involved (every such emit is scoped to a user: room).
    const roomLeak = emitted.find(e =>
      e.room === `server:${server.id}` &&
      (e.event === 'server-member-role-updated' || e.event === 'server-member-role-removed') &&
      e.payload.userId === target.id);
    expect(roomLeak).toBeUndefined();
  });
});
