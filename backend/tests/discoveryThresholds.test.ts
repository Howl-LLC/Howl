// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery growth-bar tests for the cold-start thresholds (2026-07-20
 * relaxation) and the retention minimum-cohort guard.
 *
 * The community safety floor is exercised in communityEligibility.test.ts;
 * here we assert only the four quantitative growth checks, so the fixtures
 * don't need rules/MFA/banner setup.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import {
  evaluateDiscoveryEligibility,
  DISCOVERY_MIN_MEMBERS,
  DISCOVERY_MIN_AGE_DAYS,
  DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK,
  DISCOVERY_ENGAGEMENT_WEEKS,
  DISCOVERY_MIN_RETENTION_COHORT,
  type DiscoveryEligibilityResult,
} from '../src/utils/discoveryEligibility.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';

afterAll(async () => { await cleanupTestData(); });

const DAY_MS = 24 * 60 * 60 * 1000;

function check(result: DiscoveryEligibilityResult, key: string) {
  const c = result.checks.find((entry) => entry.key === key);
  if (!c) throw new Error(`check ${key} missing from result`);
  return c;
}

/** Server aged past the bar, owned by a fresh user. */
async function agedServer() {
  const owner = await createTestUser();
  const server = await createTestServer(owner.id);
  await prisma.server.update({
    where: { id: server.id },
    data: { createdAt: new Date(Date.now() - (DISCOVERY_MIN_AGE_DAYS + 1) * DAY_MS) },
  });
  return { owner, server };
}

describe('discovery growth bars — cold-start thresholds', () => {
  it('a small-but-alive server passes all four growth bars', async () => {
    const { owner, server } = await agedServer();

    // Members: owner + enough others to reach the bar.
    const members = [owner];
    for (let i = 0; i < DISCOVERY_MIN_MEMBERS - 1; i++) {
      const u = await createTestUser();
      await prisma.serverMember.create({ data: { userId: u.id, serverId: server.id, role: 'member' } });
      members.push(u);
    }

    // Engagement: the minimum distinct authors posting once in each weekly
    // bucket (offset 1 day into the bucket so boundary rounding can't leak).
    const channel = server.channels[0];
    const authors = members.slice(0, DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK);
    for (let week = 0; week < DISCOVERY_ENGAGEMENT_WEEKS; week++) {
      for (const author of authors) {
        await prisma.message.create({
          data: {
            channelId: channel.id,
            authorId: author.id,
            content: `hello from week ${week}`,
            type: 'message',
            createdAt: new Date(Date.now() - (week * 7 + 1) * DAY_MS),
          },
        });
      }
    }

    const result = await evaluateDiscoveryEligibility(server.id);
    expect(check(result, 'minimum_age_met').met).toBe(true);
    expect(check(result, 'minimum_members_met').met).toBe(true);
    expect(check(result, 'sustained_engagement_met').met).toBe(true);
    // No DailyServerStats rows at all → no cohort → retention not enforced.
    expect(check(result, 'member_retention_met').met).toBe(true);
  });

  it('one fewer distinct messager in a single week fails the engagement bar', async () => {
    const { owner, server } = await agedServer();
    const channel = server.channels[0];
    // Full bar in week 0, one short in week 1.
    const authors = [owner];
    for (let i = 0; i < DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK - 1; i++) {
      const u = await createTestUser();
      await prisma.serverMember.create({ data: { userId: u.id, serverId: server.id, role: 'member' } });
      authors.push(u);
    }
    for (let week = 0; week < DISCOVERY_ENGAGEMENT_WEEKS; week++) {
      const weekAuthors = week === 1 ? authors.slice(0, -1) : authors;
      for (const author of weekAuthors) {
        await prisma.message.create({
          data: {
            channelId: channel.id,
            authorId: author.id,
            content: `hello from week ${week}`,
            type: 'message',
            createdAt: new Date(Date.now() - (week * 7 + 1) * DAY_MS),
          },
        });
      }
    }

    const result = await evaluateDiscoveryEligibility(server.id);
    expect(check(result, 'sustained_engagement_met').met).toBe(false);
    expect(check(result, 'sustained_engagement_met').remaining?.weeksShort).toBe(1);
  });
});

describe('discovery retention — minimum cohort guard', () => {
  it('is not enforced below the minimum cohort even at 0% retention', async () => {
    const { server } = await agedServer();
    // A cohort one short of the bar, none of whom stayed.
    await prisma.dailyServerStats.create({
      data: {
        serverId: server.id,
        date: new Date(Date.now() - 20 * DAY_MS),
        joins: DISCOVERY_MIN_RETENTION_COHORT - 1,
        retainedAfter7d: 0,
      },
    });

    const result = await evaluateDiscoveryEligibility(server.id);
    expect(check(result, 'member_retention_met').met).toBe(true);
  });

  it('is enforced once the cohort reaches the bar', async () => {
    const { server } = await agedServer();
    // Cohort at the bar, only one retained → rate below 50%.
    await prisma.dailyServerStats.create({
      data: {
        serverId: server.id,
        date: new Date(Date.now() - 20 * DAY_MS),
        joins: DISCOVERY_MIN_RETENTION_COHORT,
        retainedAfter7d: 0,
      },
    });
    await prisma.dailyServerStats.create({
      data: {
        serverId: server.id,
        date: new Date(Date.now() - 13 * DAY_MS),
        joins: 0,
        retainedAfter7d: 1,
      },
    });

    const result = await evaluateDiscoveryEligibility(server.id);
    expect(check(result, 'member_retention_met').met).toBe(false);
  });
});
