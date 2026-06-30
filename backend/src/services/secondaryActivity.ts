// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Secondary activity helpers.
 *
 * Manages the UserSecondaryActivity record — the "other" concurrent activity
 * that lost the priority check against the primary UserActivity.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'secondary-activity' });

/**
 * Write an activity to the secondary slot.
 * Used when a new activity source loses the priority check.
 */
export async function writeSecondaryActivity(
  userId: string,
  data: {
    type: string;
    name: string;
    details?: string | null;
    state?: string | null;
    largeImage?: string | null;
    smallImage?: string | null;
    startedAt?: Date;
    platformId?: string | null;
    platform?: string | null;
    durationMs?: number | null;
  },
): Promise<void> {
  try {
    await prisma.userSecondaryActivity.upsert({
      where: { userId },
      create: {
        userId,
        type: data.type,
        name: data.name,
        details: data.details ?? null,
        state: data.state ?? null,
        largeImage: data.largeImage ?? null,
        smallImage: data.smallImage ?? null,
        startedAt: data.startedAt ?? new Date(),
        platformId: data.platformId ?? null,
        platform: data.platform ?? null,
        durationMs: data.durationMs ?? null,
      },
      update: {
        type: data.type,
        name: data.name,
        details: data.details ?? null,
        state: data.state ?? null,
        largeImage: data.largeImage ?? null,
        smallImage: data.smallImage ?? null,
        platformId: data.platformId ?? null,
        platform: data.platform ?? null,
        durationMs: data.durationMs ?? null,
      },
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, userId }, 'failed to write secondary activity');
  }
}

/**
 * Move the current primary activity to the secondary slot.
 * Used when a higher-priority source overwrites the primary.
 */
export async function demotePrimaryToSecondary(userId: string): Promise<void> {
  try {
    const primary = await prisma.userActivity.findUnique({
      where: { userId },
    });
    if (!primary) return;
    await prisma.userSecondaryActivity.upsert({
      where: { userId },
      create: {
        userId,
        type: primary.type,
        name: primary.name,
        details: primary.details,
        state: primary.state,
        largeImage: primary.largeImage,
        smallImage: primary.smallImage,
        startedAt: primary.startedAt,
        platformId: primary.platformId,
        platform: primary.platform,
        durationMs: primary.durationMs,
      },
      update: {
        type: primary.type,
        name: primary.name,
        details: primary.details,
        state: primary.state,
        largeImage: primary.largeImage,
        smallImage: primary.smallImage,
        startedAt: primary.startedAt,
        platformId: primary.platformId,
        platform: primary.platform,
        durationMs: primary.durationMs,
      },
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, userId }, 'failed to demote primary to secondary');
  }
}

/**
 * Promote the secondary activity to primary.
 * Used when the primary activity clears and the secondary should take over.
 */
export async function promoteSecondaryToPrimary(userId: string): Promise<void> {
  try {
    const secondary = await prisma.userSecondaryActivity.findUnique({
      where: { userId },
    });
    if (!secondary) return;
    await prisma.userActivity.upsert({
      where: { userId },
      create: {
        userId,
        type: secondary.type,
        name: secondary.name,
        details: secondary.details,
        state: secondary.state,
        largeImage: secondary.largeImage,
        smallImage: secondary.smallImage,
        startedAt: secondary.startedAt,
        platformId: secondary.platformId,
        platform: secondary.platform,
        durationMs: secondary.durationMs,
      },
      update: {
        type: secondary.type,
        name: secondary.name,
        details: secondary.details,
        state: secondary.state,
        largeImage: secondary.largeImage,
        smallImage: secondary.smallImage,
        startedAt: secondary.startedAt,
        platformId: secondary.platformId,
        platform: secondary.platform,
        durationMs: secondary.durationMs,
      },
    });
    await prisma.userSecondaryActivity.delete({ where: { userId } }).catch(() => {});
  } catch (err) {
    log.warn({ err: (err as Error).message, userId }, 'failed to promote secondary to primary');
  }
}

/**
 * Clear the secondary activity for a user.
 */
export async function clearSecondaryActivity(userId: string): Promise<void> {
  await prisma.userSecondaryActivity.deleteMany({ where: { userId } }).catch(() => {});
}

/**
 * Clear secondary activity only if it matches a specific type.
 */
export async function clearSecondaryByType(userId: string, type: string): Promise<void> {
  await prisma.userSecondaryActivity.deleteMany({ where: { userId, type } }).catch(() => {});
}
