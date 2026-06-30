// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery x age-restricted mutual exclusion tests.
 *
 * Verifies that:
 *  1. A server with discoveryEnabled=true cannot have a channel set to ageRestricted=true.
 *  2. A server with any ageRestricted channel cannot enable discovery.
 *  3. Both operations succeed independently when neither flag conflicts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser,
  createTestServer,
  createTestChannel,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

let owner: TestUser;
let serverId: string;
let channelId: string;

beforeAll(async () => {
  owner = await createTestUser();
  const server = await createTestServer(owner.id);
  serverId = server.id;
  const channel = await createTestChannel(serverId);
  channelId = channel.id;

  // Ensure the server has community + discovery prerequisites set up
  // so the settings PATCH accepts discoveryEnabled changes.
  await prisma.serverSettings.upsert({
    where: { serverId },
    create: {
      serverId,
      communityEnabled: true,
      discoveryEnabled: false,
    },
    update: {
      communityEnabled: true,
      discoveryEnabled: false,
    },
  });
});

afterAll(cleanupTestData);

describe('PATCH channel ageRestricted=true blocked when discovery is enabled', () => {
  it('setup: enable discovery on the server', async () => {
    // Enable discovery first (no age-restricted channels exist)
    const res = await request(app)
      .patch(`/api/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ discoveryEnabled: true });
    // May get 422 if discovery eligibility bars aren't met in test env;
    // if so, force it via direct DB update for the test.
    if (res.status === 422) {
      await prisma.serverSettings.update({
        where: { serverId },
        data: { discoveryEnabled: true },
      });
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('returns 400 with age_restriction_blocked_by_discovery when setting ageRestricted=true on a channel', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/channels/${channelId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ ageRestricted: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('age_restriction_blocked_by_discovery');
  });

  it('cleanup: disable discovery', async () => {
    await prisma.serverSettings.update({
      where: { serverId },
      data: { discoveryEnabled: false },
    });
  });
});

describe('PATCH discoveryEnabled=true blocked when age-restricted channels exist', () => {
  it('setup: set a channel to ageRestricted=true', async () => {
    await prisma.channel.update({
      where: { id: channelId },
      data: { ageRestricted: true },
    });
  });

  it('returns 400 with discovery_blocked_by_age_restriction when enabling discovery', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ discoveryEnabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('discovery_blocked_by_age_restriction');
  });

  it('cleanup: remove age restriction', async () => {
    await prisma.channel.update({
      where: { id: channelId },
      data: { ageRestricted: false },
    });
  });
});

describe('both operations succeed independently when no conflict', () => {
  it('can set ageRestricted=true when discovery is disabled', async () => {
    // Ensure discovery is off
    await prisma.serverSettings.update({
      where: { serverId },
      data: { discoveryEnabled: false },
    });

    const res = await request(app)
      .patch(`/api/servers/${serverId}/channels/${channelId}`)
      .set('Authorization', authHeader(owner.token))
      .send({ ageRestricted: true });

    expect(res.status).toBe(200);
    expect(res.body.ageRestricted).toBe(true);
  });

  it('cleanup: remove age restriction for next test', async () => {
    await prisma.channel.update({
      where: { id: channelId },
      data: { ageRestricted: false },
    });
  });

  it('can enable discovery when no channels are age-restricted', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/settings`)
      .set('Authorization', authHeader(owner.token))
      .send({ discoveryEnabled: true });

    // May get 422 if discovery eligibility bars aren't met in test env —
    // that's a separate concern from the mutual exclusion. The key assertion
    // is that we do NOT get 400 with discovery_blocked_by_age_restriction.
    if (res.status === 422) {
      // Eligibility failure is acceptable — the age-restriction check passed
      expect(res.body.error).toBe('discovery_eligibility_failed');
    } else {
      expect(res.status).toBe(200);
    }
  });
});
