// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * : the channel-visibility primitive that the mention /
 * @everyone notification paths use to intersect recipients with who can READ the
 * channel. Locks the correctness landmines the adversarial scoping pass found:
 *
 *  - the gate must mirror the REST read gate, NOT filterVisibleChannelIds'
 *    server-level short-circuit (else a channel made readable purely by an
 *    override blanks out — over-restriction blackout);
 *  - `requireOverride` must hold for private-channel viewChannels (the arg-5
 *    `undefined` is load-bearing) so an @everyone viewChannels:true baseline
 *    does NOT admit a member with no override;
 *  - owner bypass (legacy 'owner' string) and the @everyone baseline must ride
 *    on the context;
 *  - `provablyOpen` must key off the @everyone baseline + visibility-relevant
 *    overrides, NOT override existence (a {sendMessages:false} announcements
 *    override must not trip it), and NOT public-ness alone (a baseline-denied
 *    public channel is NOT provably open).
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  computeProvablyOpen,
  loadChannelNotifyGate,
  filterUsersWhoCanViewChannel,
} from '../src/utils/channelVisibility.js';
import type { PermissionOverride } from '../src/utils/permissions.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

async function makeEveryoneRole(serverId: string, permissions: Record<string, boolean>): Promise<string> {
  const role = await prisma.serverRole.create({
    data: { id: randomUUID(), serverId, name: '@everyone', position: 0, isEveryone: true, permissions },
  });
  return role.id;
}

async function makeRole(serverId: string, name: string, permissions: Record<string, boolean>): Promise<string> {
  const role = await prisma.serverRole.create({
    data: { id: randomUUID(), serverId, name, position: 1, isEveryone: false, permissions },
  });
  return role.id;
}

async function addMember(serverId: string, roleIds: string[] = []): Promise<string> {
  const u = await createTestUser();
  await prisma.serverMember.create({ data: { userId: u.id, serverId, role: 'member' } });
  for (const roleId of roleIds) {
    await prisma.memberRole.create({ data: { userId: u.id, serverId, roleId } });
  }
  return u.id;
}

async function makeChannel(
  serverId: string,
  categoryId: string | null,
  opts: { isPrivate?: boolean; ageRestricted?: boolean } = {},
): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(),
      name: `c-${randomUUID().slice(0, 8)}`,
      type: 'text',
      serverId,
      categoryId,
      position: (maxPos._max.position ?? -1) + 1,
      isPrivate: opts.isPrivate ?? false,
      ageRestricted: opts.ageRestricted ?? false,
    },
  });
  return ch.id;
}

async function channelOverride(channelId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>) {
  await prisma.channelPermissionOverride.create({ data: { channelId, targetType, targetId, permissions } });
}

// ── computeProvablyOpen: pure decision matrix (no DB) ────────────────────────

describe('computeProvablyOpen', () => {
  const openEveryone = { id: 'e', position: 0, permissions: { viewChannels: true, readMessageHistory: true } };
  const readDeniedEveryone = { id: 'e', position: 0, permissions: { viewChannels: true, readMessageHistory: false } };
  const pub = { isPrivate: false, ageRestricted: false };

  it('public + open @everyone + no overrides => provably open', () => {
    expect(computeProvablyOpen(pub, [], [], openEveryone)).toBe(true);
  });

  it('private is never provably open', () => {
    expect(computeProvablyOpen({ isPrivate: true, ageRestricted: false }, [], [], openEveryone)).toBe(false);
  });

  it('age-restricted is never provably open', () => {
    expect(computeProvablyOpen({ isPrivate: false, ageRestricted: true }, [], [], openEveryone)).toBe(false);
  });

  it('baseline-denied read (public, no overrides) is NOT provably open', () => {
    expect(computeProvablyOpen(pub, [], [], readDeniedEveryone)).toBe(false);
  });

  it('missing @everyone role is NOT provably open', () => {
    expect(computeProvablyOpen(pub, [], [], null)).toBe(false);
  });

  it('administrator @everyone is provably open', () => {
    expect(computeProvablyOpen(pub, [], [], { id: 'e', position: 0, permissions: { administrator: true } })).toBe(true);
  });

  it('a non-visibility override (sendMessages:false) does NOT trip the gate', () => {
    const ovr: PermissionOverride[] = [{ targetType: 'role', targetId: 'everyone', permissions: { sendMessages: false } }];
    expect(computeProvablyOpen(pub, ovr, [], openEveryone)).toBe(true);
  });

  it('a readMessageHistory override (either polarity) trips the gate', () => {
    const deny: PermissionOverride[] = [{ targetType: 'role', targetId: 'r1', permissions: { readMessageHistory: false } }];
    const allow: PermissionOverride[] = [{ targetType: 'role', targetId: 'r1', permissions: { readMessageHistory: true } }];
    expect(computeProvablyOpen(pub, deny, [], openEveryone)).toBe(false);
    expect(computeProvablyOpen(pub, allow, [], openEveryone)).toBe(false);
  });

  it('a viewChannels category override trips the gate', () => {
    const cat: PermissionOverride[] = [{ targetType: 'role', targetId: 'r1', permissions: { viewChannels: false } }];
    expect(computeProvablyOpen(pub, [], cat, openEveryone)).toBe(false);
  });

  it('a null-valued visibility override is inert (does not trip)', () => {
    const ovr: PermissionOverride[] = [{ targetType: 'member', targetId: 'u1', permissions: { readMessageHistory: null } }];
    expect(computeProvablyOpen(pub, ovr, [], openEveryone)).toBe(true);
  });
});

// ── filterUsersWhoCanViewChannel + loadChannelNotifyGate: open baseline ───────

describe('filterUsersWhoCanViewChannel — open @everyone baseline', () => {
  let ownerId: string, plainId: string, staffId: string;
  let serverId: string, categoryId: string;
  let staffRoleId: string;
  let pubCh: string, privCh: string, privRoleGrant: string, privMemberGrant: string, privEveryoneView: string;

  beforeAll(async () => {
    const owner: TestUser = await createTestUser();
    ownerId = owner.id;
    const server = await createTestServer(ownerId);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    staffRoleId = await makeRole(serverId, 'Staff', { viewChannels: true, readMessageHistory: true });

    plainId = await addMember(serverId);
    staffId = await addMember(serverId, [staffRoleId]);

    pubCh = await makeChannel(serverId, categoryId);
    privCh = await makeChannel(serverId, categoryId, { isPrivate: true });
    privRoleGrant = await makeChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privRoleGrant, 'role', staffRoleId, { viewChannels: true, readMessageHistory: true });
    privMemberGrant = await makeChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privMemberGrant, 'member', plainId, { viewChannels: true, readMessageHistory: true });
    // private channel with an @everyone-tier viewChannels:true override present
    // but NOT granting the plain member — used to prove requireOverride still
    // demands an EXPLICIT grant even when the baseline grants viewChannels.
    privEveryoneView = await makeChannel(serverId, categoryId, { isPrivate: true });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  async function viewers(channelId: string, candidates: string[], dropMinors = false): Promise<Set<string>> {
    const gate = await loadChannelNotifyGate(channelId);
    expect(gate).not.toBeNull();
    return filterUsersWhoCanViewChannel({ gate: gate!, candidateUserIds: candidates, dropMinors });
  }

  it('public channel is provably open and admits every member', async () => {
    const gate = await loadChannelNotifyGate(pubCh);
    expect(gate!.provablyOpen).toBe(true);
    const v = await filterUsersWhoCanViewChannel({ gate: gate!, candidateUserIds: [ownerId, plainId, staffId] });
    expect(v).toEqual(new Set([ownerId, plainId, staffId]));
  });

  it('private channel with no override: only the owner views', async () => {
    const gate = await loadChannelNotifyGate(privCh);
    expect(gate!.provablyOpen).toBe(false);
    expect(await viewers(privCh, [ownerId, plainId, staffId])).toEqual(new Set([ownerId]));
  });

  it('private channel with a ROLE grant: owner + role holders view', async () => {
    expect(await viewers(privRoleGrant, [ownerId, plainId, staffId])).toEqual(new Set([ownerId, staffId]));
  });

  it('private channel with a MEMBER grant: owner + the granted member view', async () => {
    expect(await viewers(privMemberGrant, [ownerId, plainId, staffId])).toEqual(new Set([ownerId, plainId]));
  });

  it('requireOverride: @everyone viewChannels:true does NOT admit a member with no override on a private channel', async () => {
    // Only the owner (bypass) views; plain + staff are refused despite the
    // @everyone baseline granting viewChannels, because private requires an
    // EXPLICIT override grant. This is the arg-5 `undefined` landmine.
    expect(await viewers(privEveryoneView, [ownerId, plainId, staffId])).toEqual(new Set([ownerId]));
  });

  it('drops a user who is not a member of the server', async () => {
    const stranger = await createTestUser();
    expect(await viewers(pubCh, [stranger.id, ownerId])).toEqual(new Set([ownerId]));
  });

  it('returns a DM/non-existent channel as null gate (fail-closed)', async () => {
    expect(await loadChannelNotifyGate(randomUUID())).toBeNull();
  });
});

// ── baseline-denied server: the v1 leak case ─────────────────────────────────

describe('filterUsersWhoCanViewChannel — @everyone denies readMessageHistory', () => {
  let ownerId: string, plainId: string, staffId: string;
  let serverId: string, categoryId: string, staffRoleId: string;
  let pubCh: string;

  beforeAll(async () => {
    const owner = await createTestUser();
    ownerId = owner.id;
    const server = await createTestServer(ownerId);
    serverId = server.id;
    categoryId = server.categories[0].id;
    // Baseline: everyone can SEE channels but cannot READ history unless a role grants it.
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: false });
    staffRoleId = await makeRole(serverId, 'Staff', { readMessageHistory: true });
    plainId = await addMember(serverId);
    staffId = await addMember(serverId, [staffRoleId]);
    pubCh = await makeChannel(serverId, categoryId); // public, no overrides
  });

  afterAll(async () => {
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('a public no-override channel is NOT provably open when the baseline denies read', async () => {
    const gate = await loadChannelNotifyGate(pubCh);
    expect(gate!.provablyOpen).toBe(false);
  });

  it('excludes the plain member (baseline read denied) and includes staff + owner', async () => {
    const gate = await loadChannelNotifyGate(pubCh);
    const v = await filterUsersWhoCanViewChannel({ gate: gate!, candidateUserIds: [ownerId, plainId, staffId] });
    expect(v).toEqual(new Set([ownerId, staffId]));
  });
});

// ── age filtering ────────────────────────────────────────────────────────────

describe('filterUsersWhoCanViewChannel — dropMinors', () => {
  let ownerId: string, adultId: string, minorId: string;
  let serverId: string, categoryId: string, ageCh: string;

  beforeAll(async () => {
    const owner = await createTestUser();
    ownerId = owner.id;
    const server = await createTestServer(ownerId);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    adultId = await addMember(serverId);
    minorId = await addMember(serverId);
    await prisma.user.update({ where: { id: minorId }, data: { dateOfBirth: new Date(Date.now() - 13 * 365 * 24 * 3600 * 1000) } });
    ageCh = await makeChannel(serverId, categoryId, { ageRestricted: true });
  });

  afterAll(async () => {
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('drops the minor when dropMinors is set; keeps them otherwise', async () => {
    const gate = await loadChannelNotifyGate(ageCh);
    const withDrop = await filterUsersWhoCanViewChannel({ gate: gate!, candidateUserIds: [ownerId, adultId, minorId], dropMinors: true });
    expect(withDrop).toEqual(new Set([ownerId, adultId]));
    const noDrop = await filterUsersWhoCanViewChannel({ gate: gate!, candidateUserIds: [ownerId, adultId, minorId], dropMinors: false });
    expect(noDrop).toEqual(new Set([ownerId, adultId, minorId]));
  });
});
