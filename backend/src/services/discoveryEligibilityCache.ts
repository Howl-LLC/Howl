// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery-eligibility caching + persistence layer.
 *
 * Wraps `evaluateDiscoveryEligibility` so callers don't pay the full
 * Prisma roundtrip on every read. Two layers:
 *
 *   1. Redis cache (5-min TTL) — bounds DB cost during the public-launch
 *      flash flood (~10K connect storm). Cache-miss recomputes and writes
 *      back. Per-serverId key.
 *   2. Persistent `ServerSettings.eligibleForDiscoverySince` column —
 *      recomputed on every cache miss; set to first-eligible timestamp
 *      when checks pass and was previously null; cleared if the server
 *      drops below the bar. The discovery query filter reads only this
 *      column (single JOIN, no per-row recompute).
 *
 * Cache invalidation is callable from any mutation that could change
 * eligibility: settings PATCH (description, icon), member join/leave,
 * server icon update.
 */

import { prisma } from '../db.js';
import { redis } from '../redis.js';
import { logger } from '../logger.js';
import {
  evaluateDiscoveryEligibility,
  type DiscoveryEligibilityResult,
} from '../utils/discoveryEligibility.js';

const log = logger.child({ module: 'discoveryEligibilityCache' });

const CACHE_PREFIX = 'discov-elig:';
const CACHE_TTL_SEC = 300; // 5 min

/**
 * Read eligibility through the cache. On miss, recomputes from Prisma
 * and updates both the Redis cache and the persistent
 * `ServerSettings.eligibleForDiscoverySince` column.
 */
export async function getDiscoveryEligibility(
  serverId: string,
): Promise<DiscoveryEligibilityResult> {
  if (redis) {
    try {
      const cached = await redis.get(`${CACHE_PREFIX}${serverId}`);
      if (cached) {
        return JSON.parse(cached) as DiscoveryEligibilityResult;
      }
    } catch (err) {
      // Redis read failure is non-fatal — fall through to recompute.
      log.warn({ err, serverId }, 'eligibility cache read failed');
    }
  }

  const result = await evaluateDiscoveryEligibility(serverId);

  // Persist column AND cache in parallel — both are best-effort writes;
  // the eligibility result is already returned to the caller above.
  await Promise.all([
    persistEligibilityColumn(serverId, result.eligible),
    cacheEligibilityResult(serverId, result),
  ]);

  return result;
}

/**
 * Force-invalidate the Redis cache key for a server. Call after any
 * mutation that could change eligibility (icon, description, settings,
 * member join/leave, suspend/unsuspend).
 *
 * Does NOT recompute or update the persistent column — that happens
 * lazily on the next `getDiscoveryEligibility` call. The next discovery
 * query will still see the old `eligibleForDiscoverySince` value until
 * a recompute runs (eventual consistency: 5 min in the worst case, or
 * immediately if an owner re-views their settings panel).
 */
export async function invalidateDiscoveryEligibility(serverId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`${CACHE_PREFIX}${serverId}`);
  } catch (err) {
    log.warn({ err, serverId }, 'eligibility cache invalidation failed');
  }
}

async function persistEligibilityColumn(serverId: string, eligible: boolean): Promise<void> {
  try {
    const existing = await prisma.serverSettings.findUnique({
      where: { serverId },
      select: { eligibleForDiscoverySince: true },
    });
    if (!existing) return; // server has no settings row yet — nothing to persist

    const currentlySet = existing.eligibleForDiscoverySince !== null;
    if (eligible && !currentlySet) {
      await prisma.serverSettings.update({
        where: { serverId },
        data: { eligibleForDiscoverySince: new Date() },
      });
    } else if (!eligible && currentlySet) {
      await prisma.serverSettings.update({
        where: { serverId },
        data: { eligibleForDiscoverySince: null },
      });
    }
  } catch (err) {
    log.warn({ err, serverId }, 'eligibility column persist failed');
  }
}

async function cacheEligibilityResult(
  serverId: string,
  result: DiscoveryEligibilityResult,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(
      `${CACHE_PREFIX}${serverId}`,
      JSON.stringify(result),
      'EX',
      CACHE_TTL_SEC,
    );
  } catch (err) {
    log.warn({ err, serverId }, 'eligibility cache write failed');
  }
}
