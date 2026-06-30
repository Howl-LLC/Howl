// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { isValidUUID } from '../socketSchemas.js';
import { checkSocketRateLimit, cappedMapSet } from './infrastructure.js';

export function registerForumHandlers(ctx: SocketContext): void {
  const { socket, userId } = ctx;
  const log = logger.child({ module: 'socket:forum', userId });

  // Per-post typing throttle (3s per post per user, matching channel typing pattern)
  const forumTypingThrottle = new Map<string, number>();
  const FORUM_TYPING_THROTTLE_MS = 3000;

  socket.on('disconnect', () => { forumTypingThrottle.clear(); });

  socket.on('forum-post-typing', async (data: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }

      if (typeof data !== 'object' || data === null) return;
      const { serverId, channelId, postId } = data as Record<string, unknown>;
      if (!isValidUUID(serverId) || !isValidUUID(channelId) || !isValidUUID(postId)) return;

      // Per-post throttle: suppress duplicate typing events within 3s
      const now = Date.now();
      const throttleKey = postId as string;
      const last = forumTypingThrottle.get(throttleKey);
      if (last && now - last < FORUM_TYPING_THROTTLE_MS) return;
      cappedMapSet(forumTypingThrottle, throttleKey, now, 500);

      // Verify membership
      const member = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId, serverId } },
        select: { userId: true },
      });
      if (!member) return;

      // Defense-in-depth re-gate: only emit to the channel room the sender currently belongs to,
      // so users without channel access don't get presence leaks via typing events.
      // Excludes the sender (socket.to vs io.to) so the typer doesn't see their own dot light up.
      if (!socket.rooms.has(`channel:${channelId as string}`)) return;
      socket.to(`channel:${channelId as string}`).emit('forum-post-typing', {
        serverId,
        channelId,
        postId,
        userId,
      });
    } catch (err) {
      log.error({ err, event: 'forum-post-typing' }, 'Forum typing handler error');
    }
  });
}
