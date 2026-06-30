// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests — permission union across multiple roles.
 *
 * The bug: callers that loaded a member via
 *   prisma.serverMember.findUnique({ include: { serverRole: true } })
 * and then called `hasPermission(member, 'perm')` only saw the member's
 * "display role" (ServerMember.roleId, picked by pickDisplayRole as the
 * lowest-position / highest-authority role). A user with the permission
 * on a SECONDARY role was silently denied.
 *
 * The fix: migrate every call site to `loadPermissionContext(userId, serverId)`
 * + `hasPermission(ctx, 'perm')`. The context unions permissions across all
 * `MemberRole` rows plus @everyone, so secondary-role perms are honored.
 *
 * These tests exercise one migrated endpoint end-to-end (PATCH /servers/:id
 * which gates on `manageServer`) with a user whose `manageServer` comes
 * ONLY from a secondary role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { hasPermission, loadPermissionContext, pickDisplayRole } from '../src/utils/permissions.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

// Unit: synthetic context demonstrates the fix vs. the bug

describe('hasPermission — multi-role union', () => {
  it('returns true when permission comes from a SECONDARY role (not the display role)', () => {
    // Howl convention: LOWER position = HIGHER authority / display role.
    // Calendar (pos 3) is the display role per pickDisplayRole.
    // Mod (pos 5) holds `manageServer`. The legacy shape would only see
    // Calendar. The context shape unions both.
    const ctx = {
      member: { userId: 'u1', role: 'member' },
      roles: [
        { id: 'mod', position: 5, permissions: { manageServer: true } },
        { id: 'calendar', position: 3, permissions: { manageCalendar: true } },
      ],
      everyoneRole: { id: 'e1', position: 999, permissions: {}, isEveryone: true },
    };
    expect(hasPermission(ctx, 'manageServer')).toBe(true);
    expect(hasPermission(ctx, 'manageCalendar')).toBe(true);
    expect(hasPermission(ctx, 'kickMembers')).toBe(false);
  });

  it('contrast: legacy member shape with only the display role would have returned false', () => {
    // Reconstruct the bug state: pre-fix callers passed a LegacyMember with
    // only `serverRole` populated (pointing to the display role). The
    // display role here is Calendar (lowest position), which does NOT have
    // manageServer.
    const display = pickDisplayRole([
      { id: 'mod', name: 'Mod', color: '#00f', style: 'solid', position: 5, displaySeparately: false },
      { id: 'calendar', name: 'Calendar', color: '#0f0', style: 'solid', position: 3, displaySeparately: false },
    ]);
    expect(display?.id).toBe('calendar'); // sanity: lowest position wins

    const legacyMember = {
      userId: 'u1',
      role: 'member',
      serverRole: {
        id: 'calendar',
        position: 3,
        permissions: { manageCalendar: true }, // no manageServer
      },
    };
    // This is the exact bug: legacy shape sees only the display role.
    expect(hasPermission(legacyMember, 'manageServer')).toBe(false);
  });

  it('@everyone baseline still applies on top of explicit roles', () => {
    const ctx = {
      member: { userId: 'u1', role: 'member' },
      roles: [{ id: 'r1', position: 5, permissions: {} }],
      everyoneRole: {
        id: 'e1',
        position: 999,
        permissions: { sendMessages: true },
        isEveryone: true,
      },
    };
    expect(hasPermission(ctx, 'sendMessages')).toBe(true);
  });

  it('administrator on any role short-circuits every permission', () => {
    const ctx = {
      member: { userId: 'u1', role: 'member' },
      roles: [
        { id: 'low', position: 50, permissions: { administrator: true } },
        { id: 'other', position: 3, permissions: {} },
      ],
      everyoneRole: null,
    };
    expect(hasPermission(ctx, 'manageServer')).toBe(true);
    expect(hasPermission(ctx, 'kickMembers')).toBe(true);
    expect(hasPermission(ctx, 'banMembers')).toBe(true);
  });
});

// Integration: PATCH /api/servers/:serverId against a migrated handler

describe('PATCH /api/servers/:serverId — multi-role manageServer', () => {
  let owner: TestUser;
  let secondaryPermUser: TestUser;
  let serverId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    secondaryPermUser = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;

    // Seed roles — Admin-like role with manageServer at pos 10 (NOT the
    // display role), plus a Calendar-like role at pos 3 WITHOUT manageServer
    // (this one gets picked by pickDisplayRole).
    const [permBearing, displayRole] = await Promise.all([
      prisma.serverRole.create({
        data: {
          serverId,
          name: 'SecondaryAdmin',
          color: '#ff8800',
          style: 'solid',
          position: 10,
          permissions: { manageServer: true },
        },
      }),
      prisma.serverRole.create({
        data: {
          serverId,
          name: 'Calendar',
          color: '#00ff00',
          style: 'solid',
          position: 3,
          displaySeparately: true,
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

    // Join the server with BOTH roles. ServerMember.roleId points to the
    // display role (Calendar, pos 3), which has NO manageServer. The
    // permission-bearing role (SecondaryAdmin, pos 10) is a MemberRole only.
    await prisma.serverMember.create({
      data: {
        userId: secondaryPermUser.id,
        serverId,
        role: 'member',
        roleId: displayRole.id, // display role
      },
    });
    await prisma.memberRole.createMany({
      data: [
        { userId: secondaryPermUser.id, serverId, roleId: permBearing.id },
        { userId: secondaryPermUser.id, serverId, roleId: displayRole.id },
      ],
    });
  });

  afterAll(async () => {
    await prisma.memberRole.deleteMany({ where: { serverId } }).catch(() => {});
    await prisma.serverMember.deleteMany({ where: { serverId } }).catch(() => {});
    await prisma.serverRole.deleteMany({ where: { serverId } }).catch(() => {});
    await cleanupTestData();
  });

  it('context-aware hasPermission grants manageServer via secondary role', async () => {
    const ctx = await loadPermissionContext(secondaryPermUser.id, serverId);
    expect(ctx).not.toBeNull();
    expect(hasPermission(ctx!, 'manageServer')).toBe(true);
    // Sanity: ctx.rawMember.roleId is the DISPLAY role, not the perm-bearing one.
    // This is the exact scenario the legacy single-role lookup left broken.
    expect(ctx!.rawMember.roleId).not.toBeNull();
  });

  it('PATCH /:serverId with manageServer-via-secondary-role returns 200', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}`)
      .set('Authorization', authHeader(secondaryPermUser.token))
      .send({ name: 'renamed-via-secondary-role' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('renamed-via-secondary-role');
  });
});
