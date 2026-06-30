// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests — role hierarchy comparator on
 * timeout / nickname / voice server-mute / voice move.
 *
 * Howl's role convention: LOWER position number = HIGHER authority.
 * The bug (pre-fix) used `targetPos >= actorPos` with `?? 0` fallback,
 * which inverted the intent and blocked Admin-moderates-Mod while
 * allowing Mod-moderates-Admin. After the fix, the comparator is
 * `targetPosition <= actorPosition` with `Infinity` fallback, and the
 * actor/target effective position is computed across ALL roles (min),
 * not just the display role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { effectivePosition, loadPermissionContext } from '../src/utils/permissions.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

// Unit tests for effectivePosition

describe('effectivePosition (shared primitive)', () => {
  it('returns Infinity for a member with no explicit roles', () => {
    const pos = effectivePosition({
      member: { userId: 'u1', role: 'member' },
      roles: [],
      everyoneRole: { id: 'e1', position: 999, permissions: {}, isEveryone: true },
    });
    expect(pos).toBe(Infinity);
  });

  it('returns the single role position when only one role is assigned', () => {
    const pos = effectivePosition({
      member: { userId: 'u1', role: 'member' },
      roles: [{ id: 'r1', position: 5, permissions: {} }],
      everyoneRole: null,
    });
    expect(pos).toBe(5);
  });

  it('returns the MIN position across multiple roles (highest authority wins)', () => {
    // Mod (pos 5) + Calendar-helper (pos 3) → effective pos = 3.
    // This exact scenario is called out in the task as a required regression.
    const pos = effectivePosition({
      member: { userId: 'u1', role: 'member' },
      roles: [
        { id: 'mod', position: 5, permissions: { timeoutMembers: true } },
        { id: 'calendar', position: 3, permissions: { manageCalendar: true } },
      ],
      everyoneRole: null,
    });
    expect(pos).toBe(3);
  });

  it('does NOT treat a role-less member as position 0 (Owner)', () => {
    // Pre-fix bug: `?? 0` made role-less users look like Owner-tier.
    // Post-fix: role-less = Infinity (neutral / @everyone tier).
    expect(effectivePosition({ member: { userId: 'u1' }, roles: [], everyoneRole: null })).toBe(Infinity);
    expect(effectivePosition({ member: { userId: 'u1' }, roles: [], everyoneRole: null })).not.toBe(0);
  });

  it('correctly orders Admin < Mod < @everyone-level in hierarchy checks', () => {
    const adminCtx = { member: { userId: 'a' }, roles: [{ id: 'admin', position: 1, permissions: {} }], everyoneRole: null };
    const modCtx = { member: { userId: 'm' }, roles: [{ id: 'mod', position: 5, permissions: {} }], everyoneRole: null };
    const memberCtx = { member: { userId: 'r' }, roles: [], everyoneRole: null };

    const adminPos = effectivePosition(adminCtx);
    const modPos = effectivePosition(modCtx);
    const memberPos = effectivePosition(memberCtx);

    // Admin can act on Mod (mod pos > admin pos).
    expect(modPos <= adminPos).toBe(false); // target NOT equal-or-higher → allowed
    // Mod cannot act on Admin (admin pos < mod pos means admin is equal-or-higher from mod's perspective).
    expect(adminPos <= modPos).toBe(true); // target IS equal-or-higher → blocked
    // Mod can act on role-less member.
    expect(memberPos <= modPos).toBe(false); // role-less is Infinity > mod pos → allowed
    // Admin can act on role-less member.
    expect(memberPos <= adminPos).toBe(false);
    // Admin cannot act on themselves (equal position).
    expect(adminPos <= adminPos).toBe(true);
  });
});

// Integration tests — timeout + nickname routes

let owner: TestUser;
let admin: TestUser;
let mod: TestUser;
let roleless: TestUser;
let serverId: string;
let adminRoleId: string;
let modRoleId: string;
let calendarRoleId: string;

async function createServerWithRoles(ownerUser: TestUser) {
  const server = await createTestServer(ownerUser.id);
  serverId = server.id;

  // Seed Admin (pos 1), Mod (pos 5), Calendar (pos 3), @everyone (pos 999) roles.
  const [adminRole, modRole, calendarRole] = await Promise.all([
    prisma.serverRole.create({
      data: {
        serverId,
        name: 'Admin',
        color: '#ff0000',
        style: 'solid',
        position: 1,
        permissions: {
          timeoutMembers: true,
          manageNicknames: true,
          muteMembers: true,
          moveMembers: true,
        },
      },
    }),
    prisma.serverRole.create({
      data: {
        serverId,
        name: 'Mod',
        color: '#0000ff',
        style: 'solid',
        position: 5,
        permissions: {
          timeoutMembers: true,
          manageNicknames: true,
          muteMembers: true,
          moveMembers: true,
        },
      },
    }),
    prisma.serverRole.create({
      data: {
        serverId,
        name: 'Calendar',
        color: '#00ff00',
        style: 'solid',
        position: 3,
        permissions: { manageCalendar: true },
      },
    }),
    prisma.serverRole.create({
      data: {
        serverId,
        name: '@everyone',
        color: '#99aab5',
        style: 'solid',
        position: 999,
        locked: true,
        isEveryone: true,
        permissions: {},
      },
    }),
  ]);
  adminRoleId = adminRole.id;
  modRoleId = modRole.id;
  calendarRoleId = calendarRole.id;
}

async function joinServer(user: TestUser, roleIds: string[]) {
  await prisma.serverMember.create({
    data: {
      userId: user.id,
      serverId,
      role: 'member',
      roleId: roleIds[0] ?? null,
    },
  });
  for (const roleId of roleIds) {
    await prisma.memberRole.create({
      data: { userId: user.id, serverId, roleId },
    });
  }
}

describe('POST /api/servers/:serverId/members/:userId/timeout', () => {
  beforeAll(async () => {
    owner = await createTestUser();
    admin = await createTestUser();
    mod = await createTestUser();
    roleless = await createTestUser();
    await createServerWithRoles(owner);
    await joinServer(admin, [adminRoleId]);
    await joinServer(mod, [modRoleId]);
    await joinServer(roleless, []);
  });

  afterAll(async () => {
    // Targeted cleanup so we do not nuke other test suites' data mid-run.
    await prisma.memberRole.deleteMany({ where: { serverId } }).catch(() => {});
    await prisma.serverMember.deleteMany({ where: { serverId } }).catch(() => {});
    await prisma.serverRole.deleteMany({ where: { serverId } }).catch(() => {});
    await cleanupTestData();
  });

  it('Admin (pos 1) CAN timeout Mod (pos 5) — passes after fix', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${mod.id}/timeout`)
      .set('Authorization', authHeader(admin.token))
      .send({ durationSeconds: 60, reason: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.timeoutUntil).toBeDefined();
    // Clear it so later assertions do not see a stale timeout on mod.
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: mod.id, serverId } },
      data: { timeoutUntil: null, timeoutReason: null, timedOutById: null },
    });
  });

  it('Mod (pos 5) CANNOT timeout Admin (pos 1) — 403', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${admin.id}/timeout`)
      .set('Authorization', authHeader(mod.token))
      .send({ durationSeconds: 60 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/role is at or above your own/i);
  });

  it('Admin CAN timeout a role-less member', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${roleless.id}/timeout`)
      .set('Authorization', authHeader(admin.token))
      .send({ durationSeconds: 60 });
    expect(res.status).toBe(200);
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: roleless.id, serverId } },
      data: { timeoutUntil: null, timeoutReason: null, timedOutById: null },
    });
  });

  it('Owner (pos 0) is untouchable — anyone trying to timeout the owner gets 400', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${owner.id}/timeout`)
      .set('Authorization', authHeader(admin.token))
      .send({ durationSeconds: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
  });

  it('multi-role effective position: Mod(5) + Calendar(3) user is shielded like pos 3 — Admin(1) still allowed', async () => {
    // Assign the Calendar role to Mod as a secondary role. Effective position
    // becomes min(5, 3) = 3. Admin (pos 1) should still be able to timeout them.
    await prisma.memberRole.create({
      data: { userId: mod.id, serverId, roleId: calendarRoleId },
    });

    // Verify effectivePosition computes as expected.
    const modCtx = await loadPermissionContext(mod.id, serverId);
    expect(modCtx).not.toBeNull();
    expect(effectivePosition(modCtx!)).toBe(3); // not 5 — secondary role lowers the number

    // Admin still wins: admin pos 1 < mod effective pos 3 → timeout allowed.
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${mod.id}/timeout`)
      .set('Authorization', authHeader(admin.token))
      .send({ durationSeconds: 60 });
    expect(res.status).toBe(200);
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: mod.id, serverId } },
      data: { timeoutUntil: null, timeoutReason: null, timedOutById: null },
    });
    await prisma.memberRole.deleteMany({
      where: { userId: mod.id, serverId, roleId: calendarRoleId },
    });
  });
});

describe('PATCH /api/servers/:serverId/members/:userId/nickname', () => {
  // Reuse the server + users from the timeout block by re-seeding in this block.
  let ownerN: TestUser;
  let adminN: TestUser;
  let modN: TestUser;
  let serverIdN: string;
  let adminRoleN: string;
  let modRoleN: string;

  beforeAll(async () => {
    ownerN = await createTestUser();
    adminN = await createTestUser();
    modN = await createTestUser();
    const server = await createTestServer(ownerN.id);
    serverIdN = server.id;

    const [a, m] = await Promise.all([
      prisma.serverRole.create({
        data: {
          serverId: serverIdN,
          name: 'Admin',
          color: '#ff0000',
          style: 'solid',
          position: 1,
          permissions: { manageNicknames: true, timeoutMembers: true },
        },
      }),
      prisma.serverRole.create({
        data: {
          serverId: serverIdN,
          name: 'Mod',
          color: '#0000ff',
          style: 'solid',
          position: 5,
          permissions: { manageNicknames: true, timeoutMembers: true },
        },
      }),
      prisma.serverRole.create({
        data: {
          serverId: serverIdN,
          name: '@everyone',
          color: '#99aab5',
          style: 'solid',
          position: 999,
          locked: true,
          isEveryone: true,
          permissions: {},
        },
      }),
    ]);
    adminRoleN = a.id;
    modRoleN = m.id;

    await prisma.serverMember.create({
      data: { userId: adminN.id, serverId: serverIdN, role: 'member', roleId: adminRoleN },
    });
    await prisma.memberRole.create({
      data: { userId: adminN.id, serverId: serverIdN, roleId: adminRoleN },
    });
    await prisma.serverMember.create({
      data: { userId: modN.id, serverId: serverIdN, role: 'member', roleId: modRoleN },
    });
    await prisma.memberRole.create({
      data: { userId: modN.id, serverId: serverIdN, roleId: modRoleN },
    });
  });

  afterAll(async () => {
    await prisma.memberRole.deleteMany({ where: { serverId: serverIdN } }).catch(() => {});
    await prisma.serverMember.deleteMany({ where: { serverId: serverIdN } }).catch(() => {});
    await prisma.serverRole.deleteMany({ where: { serverId: serverIdN } }).catch(() => {});
  });

  it('Admin (pos 1) CAN change Mod (pos 5) nickname — passes after fix', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverIdN}/members/${modN.id}/nickname`)
      .set('Authorization', authHeader(adminN.token))
      .send({ nickname: 'NewNick' });
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('NewNick');
  });

  it('Mod (pos 5) CANNOT change Admin (pos 1) nickname — 403', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverIdN}/members/${adminN.id}/nickname`)
      .set('Authorization', authHeader(modN.token))
      .send({ nickname: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/role is at or above your own/i);
  });

  it('Owner nickname cannot be changed by anyone (400, owner guard)', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverIdN}/members/${ownerN.id}/nickname`)
      .set('Authorization', authHeader(adminN.token))
      .send({ nickname: 'NotAllowed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
  });
});

// Voice handlers — effective position semantics verified via DB state
//
// The voice socket handlers (setServerMute + move-voice-user) use the same
// effectivePosition(...) primitive as the routes above. Full socket-level
// integration testing requires Redis voice participant state which is costly
// to bootstrap; the unit tests for effectivePosition cover the comparator
// logic for those sites, and the REST tests above demonstrate the end-to-end
// behaviour pattern (actor/target ctx loaded in parallel, compared with <=).

describe('voice handler position semantics (shared primitive)', () => {
  let vOwner: TestUser;
  let vAdmin: TestUser;
  let vMod: TestUser;
  let vServerId: string;

  beforeAll(async () => {
    vOwner = await createTestUser();
    vAdmin = await createTestUser();
    vMod = await createTestUser();
    const server = await createTestServer(vOwner.id);
    vServerId = server.id;

    const [a, m] = await Promise.all([
      prisma.serverRole.create({
        data: {
          serverId: vServerId,
          name: 'Admin',
          color: '#ff0000',
          style: 'solid',
          position: 1,
          permissions: { muteMembers: true, moveMembers: true },
        },
      }),
      prisma.serverRole.create({
        data: {
          serverId: vServerId,
          name: 'Mod',
          color: '#0000ff',
          style: 'solid',
          position: 5,
          permissions: { muteMembers: true, moveMembers: true },
        },
      }),
      prisma.serverRole.create({
        data: {
          serverId: vServerId,
          name: '@everyone',
          color: '#99aab5',
          style: 'solid',
          position: 999,
          locked: true,
          isEveryone: true,
          permissions: {},
        },
      }),
    ]);

    await prisma.serverMember.create({
      data: { userId: vAdmin.id, serverId: vServerId, role: 'member', roleId: a.id },
    });
    await prisma.memberRole.create({
      data: { userId: vAdmin.id, serverId: vServerId, roleId: a.id },
    });
    await prisma.serverMember.create({
      data: { userId: vMod.id, serverId: vServerId, role: 'member', roleId: m.id },
    });
    await prisma.memberRole.create({
      data: { userId: vMod.id, serverId: vServerId, roleId: m.id },
    });
  });

  afterAll(async () => {
    await prisma.memberRole.deleteMany({ where: { serverId: vServerId } }).catch(() => {});
    await prisma.serverMember.deleteMany({ where: { serverId: vServerId } }).catch(() => {});
    await prisma.serverRole.deleteMany({ where: { serverId: vServerId } }).catch(() => {});
  });

  it('loadPermissionContext + effectivePosition resolve Admin < Mod < roleless as expected', async () => {
    const [adminCtx, modCtx] = await Promise.all([
      loadPermissionContext(vAdmin.id, vServerId),
      loadPermissionContext(vMod.id, vServerId),
    ]);
    expect(adminCtx).not.toBeNull();
    expect(modCtx).not.toBeNull();

    const adminPos = effectivePosition(adminCtx!);
    const modPos = effectivePosition(modCtx!);

    // Admin-mutes-Mod allowed: modPos (5) <= adminPos (1) → false → not blocked.
    expect(modPos <= adminPos).toBe(false);
    // Mod-mutes-Admin blocked: adminPos (1) <= modPos (5) → true → blocked.
    expect(adminPos <= modPos).toBe(true);
  });

  it('an owner-actor ctx has roles.length === 0 but bypass via owner short-circuit still applies', async () => {
    const ownerCtx = await loadPermissionContext(vOwner.id, vServerId);
    expect(ownerCtx).not.toBeNull();
    expect(ownerCtx!.roles.length).toBe(0);
    expect(effectivePosition(ownerCtx!)).toBe(Infinity);
    // In the handlers, owners bypass via `actor.role?.toLowerCase() === 'owner'`
    // BEFORE the position check runs; the Infinity fallback is only the
    // neutral baseline for the non-owner path.
    expect(ownerCtx!.member.role?.toLowerCase()).toBe('owner');
  });
});

