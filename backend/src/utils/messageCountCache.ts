// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-(user, server) message count cache for the `messageCount` self-role
 * condition. Live counting on every picker fetch + every claim is too hot;
 * we cache for 5 minutes in Redis. Invalidated on each new message via the
 * existing message-create path (see routes/messages.ts).
 *
 * Falls back to direct DB count when Redis isn't available — slower but
 * always correct. Single-instance dev still works.
 */

import { redis } from '../redis.js';
import { prisma } from '../db.js';

const TTL_SECONDS = 300; // 5 min

function key(userId: string, serverId: string): string {
  return `msgcount:${serverId}:${userId}`;
}

export async function getMessageCount(userId: string, serverId: string): Promise<number> {
  if (redis) {
    try {
      const cached = await redis.get(key(userId, serverId));
      if (cached !== null) {
        const n = parseInt(cached, 10);
        if (Number.isFinite(n)) return n;
      }
    } catch { /* fall through to DB */ }
  }

  const count = await prisma.message.count({
    where: {
      authorId: userId,
      channel: { serverId },
    },
  });

  if (redis) {
    redis.setex(key(userId, serverId), TTL_SECONDS, String(count)).catch(() => { /* best-effort */ });
  }
  return count;
}

export async function invalidateMessageCount(userId: string, serverId: string): Promise<void> {
  if (redis) {
    try { await redis.del(key(userId, serverId)); } catch { /* best-effort */ }
  }
}
