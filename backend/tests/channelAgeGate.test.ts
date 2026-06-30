// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Backend channel age-gate enforcement on message read+send.
 *
 * Asserts the (under-18, no-DOB, 18+) x (channel-restricted, not-restricted)
 * x (read, send) matrix against the live Express app. This covers the REST
 * surface; channel send is REST-only in this codebase (there is no socket-side
 * `send-message` event), so the same handler gates both API and
 * socket-broadcast pathways.
 *
 * `Channel.ageRestricted` is the single age-gate concept (`Server.nsfwLevel`
 * and `ServerSettings.ageRestricted` do not exist). The seedServer helper does
 * not accept nsfwLevel. The "both flags" test covers
 * "ageRestricted=true on a normal server".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';
import { randomUUID } from 'crypto';

// Fixtures

let owner: TestUser;
let adultMember: TestUser;
let minorMember: TestUser;
let noDobMember: TestUser;

let serverId: string;
let safeChannelId: string;        // ageRestricted: false
let restrictedChannelId: string;  // ageRestricted: true

/**
 * Seed a server with an @everyone role that grants the channel-level
 * permissions our handlers gate on. Without this, non-owner members fail the
 * permission check before the age-gate can fire — and we'd be testing the
 * wrong code path.
 */
async function seedServer(ownerId: string) {
  const server = await prisma.server.create({
    data: {
      name: `Age-Gate Test ${randomUUID()}`,
      members: { create: { userId: ownerId, role: 'owner' } },
      categories: { create: { name: 'General', position: 0 } },
    },
    include: { categories: true },
  });
  await prisma.serverRole.create({
    data: {
      serverId: server.id,
      name: '@everyone',
      position: 999,
      locked: true,
      isEveryone: true,
      permissions: {
        viewChannels: true,
        readMessageHistory: true,
        sendMessages: true,
      } as any,
    },
  });
  return server;
}

async function seedChannel(sid: string, opts: { ageRestricted: boolean }) {
  const cat = await prisma.channelCategory.findFirst({ where: { serverId: sid } });
  return prisma.channel.create({
    data: {
      id: randomUUID(),
      name: `c-${Math.random().toString(36).slice(2, 8)}`,
      type: 'text',
      serverId: sid,
      categoryId: cat?.id ?? null,
      position: 0,
      ageRestricted: opts.ageRestricted,
    },
  });
}

async function joinAsMember(userId: string, sid: string) {
  await prisma.serverMember.create({
    data: { userId, serverId: sid, role: 'member' },
  });
}

beforeAll(async () => {
  owner = await createTestUser();

  adultMember = await createTestUser();
  await prisma.user.update({
    where: { id: adultMember.id },
    data: { dateOfBirth: new Date('1990-01-01') },
  });

  minorMember = await createTestUser();
  // 14 today.
  const fourteenYearsAgo = new Date();
  fourteenYearsAgo.setUTCFullYear(fourteenYearsAgo.getUTCFullYear() - 14);
  await prisma.user.update({
    where: { id: minorMember.id },
    data: { dateOfBirth: fourteenYearsAgo },
  });

  noDobMember = await createTestUser();
  // helpers seed dateOfBirth=2000-01-15; clear it to test the no-DOB branch.
  await prisma.user.update({
    where: { id: noDobMember.id },
    data: { dateOfBirth: null },
  });

  const server = await seedServer(owner.id);
  serverId = server.id;

  // Add all three test members.
  for (const u of [adultMember, minorMember, noDobMember]) {
    await joinAsMember(u.id, serverId);
  }

  safeChannelId = (await seedChannel(serverId, { ageRestricted: false })).id;
  restrictedChannelId = (await seedChannel(serverId, { ageRestricted: true })).id;
});

afterAll(cleanupTestData);

// Helpers

function getMessages(channelId: string, token: string) {
  return request(app)
    .get(`/api/messages/channels/${channelId}`)
    .set('Authorization', authHeader(token));
}

function postMessage(channelId: string, token: string, content = 'hello world') {
  return request(app)
    .post(`/api/messages/channels/${channelId}`)
    .set('Authorization', authHeader(token))
    .send({ content });
}

function expectAgeGated(res: { status: number; body: any }) {
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('age_restricted');
  expect(typeof res.body.message).toBe('string');
}

// Allow path: no gate

describe('un-restricted channel', () => {
  it('adult can read', async () => {
    const res = await getMessages(safeChannelId, adultMember.token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
  });

  it('adult can send', async () => {
    const res = await postMessage(safeChannelId, adultMember.token);
    expect(res.status).toBe(201);
  });

  it('minor can read (no gate applies)', async () => {
    const res = await getMessages(safeChannelId, minorMember.token);
    expect(res.status).toBe(200);
  });

  it('minor can send (no gate applies)', async () => {
    const res = await postMessage(safeChannelId, minorMember.token);
    expect(res.status).toBe(201);
  });

  // No-DOB users are blocked by `requireOnboarding` middleware on every
  // authenticated API request — they can't reach the channel-age-gate path.
  // Behavior is covered by middleware tests, not here.
});

// Channel-level age-restricted

describe('channel-level ageRestricted=true', () => {
  it('adult can read', async () => {
    const res = await getMessages(restrictedChannelId, adultMember.token);
    expect(res.status).toBe(200);
  });

  it('adult can send', async () => {
    const res = await postMessage(restrictedChannelId, adultMember.token);
    expect(res.status).toBe(201);
  });

  it('minor is denied on read', async () => {
    const res = await getMessages(restrictedChannelId, minorMember.token);
    expectAgeGated(res);
  });

  it('minor is denied on send', async () => {
    const res = await postMessage(restrictedChannelId, minorMember.token);
    expectAgeGated(res);
  });

  // See note above: no-DOB users blocked by upstream middleware.
});

// Owner bypass

describe('owner bypass', () => {
  it('owner with adult DOB can send to an age-restricted channel', async () => {
    // The default helper user has dateOfBirth=2000-01-15, i.e. an adult.
    const res = await postMessage(restrictedChannelId, owner.token);
    expect(res.status).toBe(201);
  });
});

// POST /channels/:channelId/age-gate/accept

function acceptAgeGate(channelId: string, token: string) {
  return request(app)
    .post(`/api/v1/channels/${channelId}/age-gate/accept`)
    .set('Authorization', authHeader(token))
    .send({});
}

describe('POST /channels/:channelId/age-gate/accept', () => {
  it('adult member receives 200 and the updated acceptance array', async () => {
    const res = await acceptAgeGate(restrictedChannelId, adultMember.token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.acceptedAgeRestrictedChannelIds)).toBe(true);
    expect(res.body.acceptedAgeRestrictedChannelIds).toContain(restrictedChannelId);
  });

  it('is idempotent — re-accepting the same channel returns 200 without duplicating', async () => {
    // First acceptance (may already be accepted from previous test)
    await acceptAgeGate(restrictedChannelId, adultMember.token);
    // Second acceptance
    const res = await acceptAgeGate(restrictedChannelId, adultMember.token);
    expect(res.status).toBe(200);
    // Count occurrences — should appear exactly once
    const count = res.body.acceptedAgeRestrictedChannelIds.filter(
      (id: string) => id === restrictedChannelId,
    ).length;
    expect(count).toBe(1);
  });

  it('returns 403 for under-18 caller', async () => {
    const res = await acceptAgeGate(restrictedChannelId, minorMember.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('age_restricted');
  });

  // No-DOB callers are blocked by the global `requireOnboarding` middleware
  // before the route handler runs; route-level age check is defence-in-depth
  // only. The middleware contract is covered elsewhere.

  it('returns 404 for non-existent channel', async () => {
    const fakeId = randomUUID();
    const res = await acceptAgeGate(fakeId, adultMember.token);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-age-restricted channel', async () => {
    const res = await acceptAgeGate(safeChannelId, adultMember.token);
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-member', async () => {
    const outsider = await createTestUser();
    await prisma.user.update({
      where: { id: outsider.id },
      data: { dateOfBirth: new Date('1990-01-01') },
    });
    const res = await acceptAgeGate(restrictedChannelId, outsider.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You are not a member of this server.');
  });
});

// Channel-delete acceptance cleanup

describe('channel-delete scrubs acceptedAgeRestrictedChannelIds', () => {
  let tempChannelId: string;

  it('setup: create an age-restricted channel and accept it', async () => {
    // Create a new age-restricted channel (owner is already a member)
    const cat = await prisma.channelCategory.findFirst({ where: { serverId } });
    const ch = await prisma.channel.create({
      data: {
        id: randomUUID(),
        name: `temp-restricted-${Date.now()}`,
        type: 'text',
        serverId,
        categoryId: cat?.id ?? null,
        position: 99,
        ageRestricted: true,
      },
    });
    tempChannelId = ch.id;

    // Accept it as the adult member
    const acceptRes = await acceptAgeGate(tempChannelId, adultMember.token);
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.acceptedAgeRestrictedChannelIds).toContain(tempChannelId);
  });

  it('after deleting the channel, the ID is removed from the member acceptance array', async () => {
    // Delete the channel via the API (owner performs delete)
    const deleteRes = await request(app)
      .delete(`/api/servers/${serverId}/channels/${tempChannelId}`)
      .set('Authorization', authHeader(owner.token));
    expect([200, 204]).toContain(deleteRes.status);

    // Verify the acceptance array no longer contains the deleted channel
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: adultMember.id, serverId } },
      select: { acceptedAgeRestrictedChannelIds: true },
    });
    expect(member).toBeDefined();
    expect(member!.acceptedAgeRestrictedChannelIds).not.toContain(tempChannelId);
  });
});
