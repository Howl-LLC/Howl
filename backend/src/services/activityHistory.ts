// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Activity history helpers — log and close history entries for the
 * ActivityHistory table, shared by activity routes, Steam polling,
 * Spotify polling, and socket handlers.
 */

import { prisma } from '../db.js';

const MAX_HISTORY_PER_USER = 20;

export async function logActivityToHistory(
  userId: string,
  activity: {
    type: string;
    name: string;
    details?: string | null;
    largeImage?: string | null;
    smallImage?: string | null;
    platformId?: string | null;
    platform?: string | null;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Deduplicate: skip if most recent entry has the same name
    const lastHistory = await tx.activityHistory.findFirst({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      select: { id: true, name: true, type: true },
    });

    if (lastHistory && lastHistory.name === activity.name) return;

    // Spotify: update the most recent spotify entry in-place instead of creating
    // a new row for every song. This prevents Spotify from flooding the history
    // and pushing game entries out via pruning.
    if (activity.type === 'spotify') {
      const lastSpotify = await tx.activityHistory.findFirst({
        where: { userId, type: 'spotify' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });

      if (lastSpotify) {
        await tx.activityHistory.update({
          where: { id: lastSpotify.id },
          data: {
            name: activity.name,
            details: activity.details ?? null,
            largeImage: activity.largeImage ?? null,
            smallImage: activity.smallImage ?? null,
            platformId: activity.platformId ?? null,
            startedAt: new Date(),
            endedAt: null,
          },
        });
        return;
      }

      // No existing spotify entry — fall through to create one
    }

    // Close previous open entry
    if (lastHistory) {
      await tx.activityHistory.update({
        where: { id: lastHistory.id },
        data: { endedAt: new Date() },
      });
    }

    await tx.activityHistory.create({
      data: {
        userId,
        type: activity.type,
        name: activity.name,
        details: activity.details ?? null,
        largeImage: activity.largeImage ?? null,
        smallImage: activity.smallImage ?? null,
        platformId: activity.platformId ?? null,
        platform: activity.platform ?? null,
      },
    });

    // Prune — probabilistic check to avoid counting on every write
    if (Math.random() < 0.1) {
      const count = await tx.activityHistory.count({ where: { userId } });
      if (count > MAX_HISTORY_PER_USER) {
        const oldest = await tx.activityHistory.findMany({
          where: { userId },
          orderBy: { startedAt: 'asc' },
          take: count - MAX_HISTORY_PER_USER,
          select: { id: true },
        });
        await tx.activityHistory.deleteMany({
          where: { id: { in: oldest.map((o: { id: string }) => o.id) } },
        });
      }
    }
  });
}

export async function closeActivityHistory(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const open = await tx.activityHistory.findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (open) {
      await tx.activityHistory.update({
        where: { id: open.id },
        data: { endedAt: new Date() },
      });
    }
  });
}
