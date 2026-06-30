// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { hasPermission, loadPermissionContext } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { isValidUUID } from '../socketSchemas.js';
import { checkSocketRateLimit } from './infrastructure.js';

export function registerThreadHandlers(ctx: SocketContext): void {
  const { socket, userId } = ctx;

  socket.on('join-thread', async (threadId: string) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      if (!isValidUUID(threadId)) return;

      const thread = await prisma.thread.findUnique({
        where: { id: threadId },
        select: { serverId: true, channelId: true },
      });
      if (!thread) return;

      const permCtx = await loadPermissionContext(userId, thread.serverId);
      if (!permCtx) return;
      if (!hasPermission(permCtx, 'readMessageHistory')) return;

      // Gate on the parent channel's private flag + channel/category overrides.
      // Without this, a server member denied viewChannels on a private channel
      // could join `thread:${id}` after observing a `thread-created` broadcast.
      // Mirrors the `join-channel` pattern in channels.ts.
      const channel = await prisma.channel.findUnique({
        where: { id: thread.channelId },
        select: { isPrivate: true, categoryId: true },
      });
      if (!channel) return;

      const [channelOverrides, categoryOverrides] = await Promise.all([
        prisma.channelPermissionOverride.findMany({ where: { channelId: thread.channelId }, take: 100 }),
        channel.categoryId
          ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 100 })
          : Promise.resolve([]),
      ]);
      if (channel.isPrivate && !hasChannelPermission(permCtx, 'viewChannels', channelOverrides, categoryOverrides)) return;
      if (!hasChannelPermission(permCtx, 'readMessageHistory', channelOverrides, categoryOverrides)) return;

      socket.join(`thread:${threadId}`);
    } catch (err) {
      logger.error({ err, userId, event: 'join-thread' }, 'socket handler error');
    }
  });

  socket.on('leave-thread', async (threadId: string) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      if (!isValidUUID(threadId)) return;
      socket.leave(`thread:${threadId}`);
    } catch (err) {
      logger.error({ err, userId, event: 'leave-thread' }, 'socket handler error');
    }
  });
}
