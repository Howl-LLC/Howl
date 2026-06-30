// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Auto-role config endpoints (GET/PUT /auto-roles) with role-hierarchy
 * enforcement.
 *
 * Howl's role convention: LOWER position number = HIGHER authority.
 * effectivePosition(ctx) = MIN position across explicit MemberRole roles
 * (Infinity when role-less). The hierarchy gate matches serverRoles.ts — a
 * non-owner cannot auto-assign a role at or above their own effective position
 * (`r.position <= actorPosition` → 403). The owner
 * (ServerMember.role === 'owner') short-circuits the gate.
 *
 * Response contract (the frontend depends on it): BOTH endpoints return
 * `{ roleIds: string[] }`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
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
let mod: TestUser; // non-owner WITH manageRoles, effective position = MOD_POS
let serverId: string;

// Role positions (lower = higher authority).
const MOD_POS = 5;
let everyoneRoleId: string;
let lockedRoleId: string; // position 8 (below mod) but locked
let hiddenRoleId: string; // position 6 (below mod) but hidden
let aboveModRoleId: string; // position 1 (above mod's authority)
let atModRoleId: string; // position 5 (equal to mod's authority)
let belowModRoleId1: string; // position 7 (strictly below mod)
let belowModRoleId2: string; // position 9 (strictly below mod)

// A role that belongs to a DIFFERENT server entirely.
let foreignServerId: string;
let foreignRoleId: string;

beforeAll(async () => {
  owner = await createTestUser();
  mod = await createTestUser();
  const server = await createTestServer(owner.id);
  serverId = server.id;

  // Seed @everyone + the role lattice. Lower position = higher authority.
  const [everyoneRole, modRole, aboveRole, lockedRole, hiddenRole, belowRole1, belowRole2] = await Promise.all([
    prisma.serverRole.create({
      data: { serverId, name: '@everyone', position: 999, locked: true, isEveryone: true, permissions: { viewChannels: true } as never },
    }),
    prisma.serverRole.create({
      data: { serverId, name: 'Mod', color: '#0000ff', position: MOD_POS, permissions: { manageRoles: true } as never },
    }),
    prisma.serverRole.create({
      data: { serverId, name: 'Admin', color: '#ff0000', position: 1, permissions: {} as never },
    }),
    prisma.serverRole.create({
      data: { serverId, name: 'Locked', color: '#888888', position: 8, locked: true, permissions: {} as never },
    }),
    prisma.serverRole.create({
      data: { serverId, name: 'Hidden', color: '#a855f7', position: 6, hidden: true, permissions: {} as never },
    }),
    prisma.serverRole.create({
      data: { serverId, name: 'Gamer', color: '#fbbf24', position: 7, permissions: {} as never },
    }),
    prisma.serverRole.create({
      data: { serverId, name: 'Artist', color: '#22d3ee', position: 9, permissions: {} as never },
    }),
  ]);
  everyoneRoleId = everyoneRole.id;
  atModRoleId = modRole.id; // pos 5 — equal to mod's own authority
  aboveModRoleId = aboveRole.id; // pos 1
  lockedRoleId = lockedRole.id; // pos 8, locked
  hiddenRoleId = hiddenRole.id; // pos 6, hidden
  belowModRoleId1 = belowRole1.id; // pos 7
  belowModRoleId2 = belowRole2.id; // pos 9

  // Make `mod` a non-owner member who HOLDS the Mod role (manageRoles, pos 5).
  await prisma.serverMember.create({ data: { serverId, userId: mod.id, role: 'member', roleId: atModRoleId } });
  await prisma.memberRole.create({ data: { serverId, userId: mod.id, roleId: atModRoleId } });

  // A foreign server with its own role — used to prove cross-server roleIds are rejected.
  const fOwner = await createTestUser();
  foreignServerId = (await createTestServer(fOwner.id)).id;
  foreignRoleId = (await prisma.serverRole.create({
    data: { serverId: foreignServerId, name: 'Foreign', position: 3, permissions: {} as never },
  })).id;
});

afterAll(async () => {
  // Targeted cleanup first (MemberRole/ServerAutoRole cascade from member/role/server).
  await prisma.serverAutoRole.deleteMany({ where: { serverId } }).catch(() => {});
  await prisma.memberRole.deleteMany({ where: { serverId } }).catch(() => {});
  await prisma.serverMember.deleteMany({ where: { serverId } }).catch(() => {});
  await prisma.serverRole.deleteMany({ where: { serverId } }).catch(() => {});
  await cleanupTestData();
});

describe('GET/PUT /auto-roles (hierarchy-enforced)', () => {
  it('1. Owner PUTs 2 valid roleIds → 200 {roleIds}; GET returns the same set', async () => {
    const put = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [belowModRoleId1, belowModRoleId2] });
    expect(put.status).toBe(200);
    expect(new Set(put.body.roleIds)).toEqual(new Set([belowModRoleId1, belowModRoleId2]));

    const get = await request(app)
      .get(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token));
    expect(get.status).toBe(200);
    expect(new Set(get.body.roleIds)).toEqual(new Set([belowModRoleId1, belowModRoleId2]));

    // Verify the row state actually persisted.
    const rows = await prisma.serverAutoRole.findMany({ where: { serverId } });
    expect(new Set(rows.map((r) => r.roleId))).toEqual(new Set([belowModRoleId1, belowModRoleId2]));
  });

  it('2a. Mod (pos 5) CANNOT auto-assign a role ABOVE their position → 403 role_above_your_position', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(mod.token))
      .send({ roleIds: [aboveModRoleId] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('role_above_your_position');
    expect(res.body.roleId).toBe(aboveModRoleId);
  });

  it('2b. Mod (pos 5) CANNOT auto-assign a role AT their position → 403 role_above_your_position', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(mod.token))
      .send({ roleIds: [atModRoleId] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('role_above_your_position');
    expect(res.body.roleId).toBe(atModRoleId);
  });

  it('2c. Mod (pos 5) CAN auto-assign a role strictly BELOW them → 200 (gate is not always-deny)', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(mod.token))
      .send({ roleIds: [belowModRoleId1] });
    expect(res.status).toBe(200);
    expect(res.body.roleIds).toEqual([belowModRoleId1]);
  });

  it('3. @everyone role id → 400 cannot_auto_assign_everyone', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [everyoneRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_auto_assign_everyone');
  });

  it('4. locked role id → 400 cannot_auto_assign_locked', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [lockedRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_auto_assign_locked');
  });

  it('4b. hidden role id → 400 cannot_auto_assign_hidden (prevents join-event display leak)', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [hiddenRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_auto_assign_hidden');

    // The reject must not persist anything.
    const rows = await prisma.serverAutoRole.findMany({ where: { serverId } });
    expect(rows.some((r) => r.roleId === hiddenRoleId)).toBe(false);
  });

  it('5. >5 roleIds → 400 (zod .max(5) via validate middleware)', async () => {
    const sixIds = Array.from({ length: 6 }, () => randomUUID());
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: sixIds });
    expect(res.status).toBe(400);
  });

  it('6. a roleId from a DIFFERENT server → 400 role_not_in_server', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [foreignRoleId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('role_not_in_server');
  });

  it('7. PUT [] → 200 clears; GET → {roleIds: []}', async () => {
    // Pre-seed so we can prove the clear.
    await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [belowModRoleId1] });

    const clear = await request(app)
      .put(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token))
      .send({ roleIds: [] });
    expect(clear.status).toBe(200);
    expect(clear.body.roleIds).toEqual([]);

    const get = await request(app)
      .get(`/api/servers/${serverId}/auto-roles`)
      .set('Authorization', authHeader(owner.token));
    expect(get.status).toBe(200);
    expect(get.body.roleIds).toEqual([]);

    const rows = await prisma.serverAutoRole.findMany({ where: { serverId } });
    expect(rows.length).toBe(0);
  });
});
