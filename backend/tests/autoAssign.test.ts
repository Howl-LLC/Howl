// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { applyAutoAssignRoles } from '../src/utils/joinWelcome.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';
describe('applyAutoAssignRoles', () => {
  let serverId: string, userId: string, roleA: string, roleB: string;
  beforeAll(async () => {
    const owner = await createTestUser();
    const joiner = await createTestUser(); userId = joiner.id;
    serverId = (await createTestServer(owner.id)).id;
    await prisma.serverRole.create({ data: { serverId, name: '@everyone', position: 999, isEveryone: true, permissions: { viewChannels: true } as never } });
    roleA = (await prisma.serverRole.create({ data: { serverId, name: 'Gamer', color: '#fbbf24', position: 5, permissions: {} as never } })).id;
    roleB = (await prisma.serverRole.create({ data: { serverId, name: 'Artist', color: '#22d3ee', position: 3, displaySeparately: true, permissions: {} as never } })).id;
    await prisma.serverMember.create({ data: { serverId, userId, role: 'member' } });
    await prisma.serverAutoRole.createMany({ data: [{ serverId, roleId: roleA }, { serverId, roleId: roleB }] });
  });
  afterAll(cleanupTestData);
  it('grants every auto-role + recomputes hoisted display role', async () => {
    const granted = await applyAutoAssignRoles(serverId, userId);
    expect(new Set(granted)).toEqual(new Set([roleA, roleB]));
    const mrs = await prisma.memberRole.findMany({ where: { userId, serverId } });
    expect(mrs.map(m => m.roleId).sort()).toEqual([roleA, roleB].sort());
    const member = await prisma.serverMember.findUnique({ where: { userId_serverId: { userId, serverId } } });
    expect(member?.roleId).toBe(roleB);
  });
  it('is idempotent', async () => {
    await applyAutoAssignRoles(serverId, userId);
    expect(await prisma.memberRole.count({ where: { userId, serverId } })).toBe(2);
  });
});
