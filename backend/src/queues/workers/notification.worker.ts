// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Notification fanout worker.
 *
 * Handles presence broadcasts and mention fanout in the background
 * so the main request handlers don't block on DB queries for large servers.
 *
 * Job data variants:
 *   { type: 'presence', userId: string, status: string }
 *   { type: 'mentions', serverId: string, channelId: string, messageId: string, content: string, authorId: string }
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { notificationJobSchema } from '../workerSchemas.js';
import { sendPushToUsers, pushEnabled } from '../../services/pushNotifications.js';
import { redis } from '../../redis.js';
import type { Server as IOServer } from 'socket.io';
import { isUnderEighteen } from '../../utils/discoveryFilters.js';

const log = logger.child({ module: 'worker:notification' });

const notifRates = new Map<string, { count: number; resetAt: number }>();
const NOTIF_RATE_WINDOW_MS = 60_000;
const MAX_NOTIFS_PER_USER_PER_MIN = 10;
const MAX_NOTIF_RATE_ENTRIES = 50_000;

async function checkNotifRate(userId: string): Promise<boolean> {
  // Redis path: atomic INCR with PEXPIRE for distributed rate limiting across workers
  if (redis) {
    try {
      const key = `notifrate:${userId}`;
      const count = await redis.eval(
        `local c = redis.call('incr', KEYS[1]) if c == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end return c`,
        1, key, NOTIF_RATE_WINDOW_MS,
      ) as number;
      return count <= MAX_NOTIFS_PER_USER_PER_MIN;
    } catch {
      return true; // fail open on Redis error
    }
  }

  // In-memory fallback (single-instance mode)
  const now = Date.now();
  const entry = notifRates.get(userId);
  if (!entry || now > entry.resetAt) {
    if (!notifRates.has(userId) && notifRates.size >= MAX_NOTIF_RATE_ENTRIES) {
      const oldest = notifRates.keys().next().value;
      if (oldest !== undefined) notifRates.delete(oldest);
    }
    notifRates.set(userId, { count: 1, resetAt: now + NOTIF_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_NOTIFS_PER_USER_PER_MIN) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of notifRates) {
    if (now > v.resetAt) notifRates.delete(k);
  }
}, 60_000).unref();

async function checkNotifRateBatch(userIds: string[]): Promise<string[]> {
  if (!redis || userIds.length === 0) {
    // Fallback to sequential in-memory check
    const allowed: string[] = [];
    for (const uid of userIds) {
      if (await checkNotifRate(uid)) allowed.push(uid);
    }
    return allowed;
  }
  try {
    const pipeline = redis.pipeline();
    for (const uid of userIds) {
      const key = `notifrate:${uid}`;
      pipeline.eval(
        `local c = redis.call('incr', KEYS[1]) if c == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end return c`,
        1, key, NOTIF_RATE_WINDOW_MS,
      );
    }
    const results = await pipeline.exec();
    const allowed: string[] = [];
    if (results) {
      for (let i = 0; i < userIds.length; i++) {
        const [err, count] = results[i] ?? [null, 0];
        if (!err && (count as number) <= MAX_NOTIFS_PER_USER_PER_MIN) {
          allowed.push(userIds[i]);
        }
      }
    }
    return allowed;
  } catch {
    return userIds; // fail open
  }
}

let _io: IOServer | null = null;

/** Must be called once at startup so the worker can emit Socket.IO events. */
export function setNotificationIO(io: IOServer) {
  _io = io;
}

import type { ActivityBroadcastPayload } from '../../socketHandlers/infrastructure.js';

export type NotificationJobData =
  | { type: 'presence'; userId: string; status: string }
  | { type: 'mentions'; serverId: string; channelId: string; messageId: string; content: string; authorId: string }
  | { type: 'dm'; dmChannelId: string; messageId: string; content: string; authorId: string; recipientIds: string[]; encrypted?: boolean }
  | { type: 'activity'; userId: string; activity: ActivityBroadcastPayload | null; secondaryActivity?: ActivityBroadcastPayload | null };

async function processNotification(job: Job<NotificationJobData>) {
  const parsed = notificationJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid notification job payload');
    return;
  }

  if (!_io) {
    log.warn({ jobId: job.id }, 'io not set — skipping notification');
    return;
  }

  const data = job.data;

  if (data.type === 'presence') {
    const visibleStatus = data.status === 'invisible' ? 'offline' : data.status;

    const memberships = await prisma.serverMember.findMany({
      where: { userId: data.userId },
      select: { serverId: true },
      take: 500,
    }).catch(() => []);

    const friendships = await prisma.friendRequest.findMany({
      where: { status: 'accepted', OR: [{ fromUserId: data.userId }, { toUserId: data.userId }] },
      select: { fromUserId: true, toUserId: true },
      take: 2000,
    }).catch(() => []);

    const friendIds = friendships.map((f) =>
      f.fromUserId === data.userId ? f.toUserId : f.fromUserId,
    );

    // Single broadcast to friends + server members (mirrors
    // broadcastPresenceChange in infrastructure.ts). The prior friends_only
    // split emitted different payloads to user vs server rooms, which the
    // client's last-write-wins presence buffer collapsed, producing drift
    // between the home friends list and server sidebars.
    const rooms: string[] = memberships.map(m => `server:${m.serverId}`);
    rooms.push(...friendIds.map(fid => `user:${fid}`));
    if (rooms.length > 0) {
      _io.to(rooms).emit('presence-update', { userId: data.userId, status: visibleStatus });
    }
    log.debug({ jobId: job.id, userId: data.userId, servers: memberships.length, friends: friendIds.length }, 'presence broadcast');
    return;
  }

  if (data.type === 'mentions') {
    // eslint-disable-next-line security/detect-unsafe-regex
    const MENTION_REGEX = /@(?:<([^>]+)>|(everyone|here|[a-zA-Z0-9_]{1,32}(?:#\d{4})?))/gi;
    const matches = [...data.content.matchAll(MENTION_REGEX)].map((m) => (m[1] || m[2] || '').toLowerCase());
    if (matches.length === 0) return;

    const hasEveryone = matches.some(tag => tag === 'everyone' || tag === 'here');

    if (hasEveryone) {
      // Emit to the server room — all members are already in it. Carries no
      // message content (just channelId + messageId), so it is safe to fan
      // out to minors even when the channel is age-gated; client-side they
      // cannot enter the channel to see the content.
      _io.to(`server:${data.serverId}`).emit('server-channel-activity', {
        serverId: data.serverId,
        channelId: data.channelId,
        messageId: data.messageId,
        mentionUserIds: ['@everyone'],
      });

      // Fetch author + channel info for push and persistent notifications.
      // `ageRestricted` drives the per-recipient minor filter below — push
      // bodies and Notification rows DO carry message content.
      const [authorUser, channel] = await Promise.all([
        prisma.user.findUnique({ where: { id: data.authorId }, select: { username: true } }),
        prisma.channel.findUnique({ where: { id: data.channelId }, select: { name: true, ageRestricted: true } }),
      ]);
      const authorName = authorUser?.username ?? 'Someone';
      const channelName = channel?.name ?? 'channel';
      const channelAgeRestricted = !!channel?.ageRestricted;
      const preview = data.content.length > 200 ? data.content.slice(0, 200) + '…' : data.content;

      // Filter out users who have this server in a muted folder
      let mutedUserIds = new Set<string>();
      try {
        const mutedFolders = await prisma.serverFolder.findMany({
          where: { muted: true, serverIds: { has: data.serverId } },
          select: { userId: true },
          take: 50000,
        });
        mutedUserIds = new Set(mutedFolders.map((f) => f.userId));
      } catch { /* fail open — don't block notifications on query failure */ }

      // Push notifications: paginate through members in batches
      const BATCH_SIZE = 1000;
      let skip = 0;
      const allMemberIds: string[] = [];
      while (true) {
        const batch = await prisma.serverMember.findMany({
          where: { serverId: data.serverId },
          select: { userId: true },
          take: BATCH_SIZE,
          skip,
        });
        if (batch.length === 0) break;
        skip += batch.length;

        let batchUserIds = batch.map(m => m.userId).filter(uid => uid !== data.authorId);
        if (channelAgeRestricted && batchUserIds.length > 0) {
          // Drop minors before either push or persistent notification — the
          // payload carries the message preview which would otherwise bypass
          // the per-channel age gate. Missing user rows are treated as minors
          // (fail-closed, matches `isUnderEighteen`'s null handling).
          const ages = await prisma.user.findMany({
            where: { id: { in: batchUserIds } },
            select: { id: true, dateOfBirth: true },
            take: batchUserIds.length,
          });
          const adults = new Set(
            ages.filter(u => !isUnderEighteen(u.dateOfBirth)).map(u => u.id),
          );
          batchUserIds = batchUserIds.filter(uid => adults.has(uid));
        }
        allMemberIds.push(...batchUserIds);

        if (pushEnabled) {
          const rateLimited = await checkNotifRateBatch(batchUserIds);
          if (rateLimited.length > 0) {
            const [dndUsers, desktopDisabledUsers] = await Promise.all([
              prisma.user.findMany({ where: { id: { in: rateLimited }, status: 'dnd' }, select: { id: true }, take: 10000 }).catch(() => []),
              prisma.user.findMany({ where: { id: { in: rateLimited }, notifyDesktop: false }, select: { id: true }, take: 10000 }).catch(() => []),
            ]);
            const dndSet = new Set(dndUsers.map(u => u.id));
            const desktopDisabledSet = new Set(desktopDisabledUsers.map(u => u.id));
            const eligible = rateLimited.filter(uid => !dndSet.has(uid) && !mutedUserIds.has(uid) && !desktopDisabledSet.has(uid));
            if (eligible.length > 0) {
              await sendPushToUsers(eligible, {
                title: `${authorName} mentioned you in #${channelName}`,
                body: preview,
                tag: `mention-${data.channelId}`,
                url: `/channels/${data.serverId}/${data.channelId}`,
              }).catch(err => log.warn({ err }, 'push mention fanout failed'));
            }
          }
        }
        if (batch.length < BATCH_SIZE) break;
      }

      // Create persistent Notification records (fire-and-forget, batched)
      if (allMemberIds.length > 0) {
        const notifTitle = `${authorName} mentioned @everyone in #${channelName}`;
        for (let i = 0; i < allMemberIds.length; i += BATCH_SIZE) {
          const chunk = allMemberIds.slice(i, i + BATCH_SIZE).filter(uid => !mutedUserIds.has(uid));
          prisma.notification.createMany({
            data: chunk.map(uid => ({
              userId: uid,
              serverId: data.serverId,
              channelId: data.channelId,
              type: 'everyone',
              title: notifTitle,
              body: preview,
              metadata: { messageId: data.messageId, authorId: data.authorId, authorUsername: authorName, channelName },
            })),
          }).catch(() => {});
        }

        // Batch increment ChannelReadState.mentionCount for all members via raw SQL
        // Uses INSERT...ON CONFLICT to upsert in a single query instead of N individual upserts
        if (allMemberIds.length > 0) {
          const channelId = data.channelId;
          for (let i = 0; i < allMemberIds.length; i += 500) {
            const chunk = allMemberIds.slice(i, i + 500);
            prisma.$executeRaw`
              INSERT INTO "ChannelReadState" ("userId", "channelId", "lastReadAt", "mentionCount")
              SELECT unnest(${chunk}::text[]), ${channelId}::text, NOW(), 1
              ON CONFLICT ("userId", "channelId")
              DO UPDATE SET "mentionCount" = "ChannelReadState"."mentionCount" + 1
            `.catch(() => {});
          }
        }

        // Emit to server room — all members are already joined, avoids N per-user Redis pub/sub messages
        _io.to(`server:${data.serverId}`).emit('notification-created', {
          serverId: data.serverId,
          channelId: data.channelId,
          type: 'everyone',
          title: notifTitle,
          body: preview,
          metadata: { messageId: data.messageId, authorId: data.authorId, authorUsername: authorName, channelName },
          createdAt: new Date().toISOString(),
        });
      }

      log.debug({ jobId: job.id, mentions: '@everyone' }, 'mention fanout');
      return;
    }

    // Targeted mentions only — fetch only the referenced users/roles
    const userMentions: { username: string; disc: string | null }[] = [];
    const roleMentionNames: string[] = [];
    for (const tag of matches) {
      if (tag.includes('#')) {
        const idx = tag.lastIndexOf('#');
        userMentions.push({ username: tag.slice(0, idx).toLowerCase(), disc: tag.slice(idx + 1) });
      } else {
        roleMentionNames.push(tag);
      }
    }

    const mentionedIds = new Set<string>();

    // Fetch only roles that match mention names
    if (roleMentionNames.length > 0) {
      const uniqueRoleNames = [...new Set(roleMentionNames)];
      const roles = await prisma.serverRole.findMany({
        where: { serverId: data.serverId, name: { in: uniqueRoleNames, mode: 'insensitive' } },
        select: { members: { select: { userId: true }, take: 10000 } },
        take: 100,
      });
      for (const role of roles) {
        for (const rm of role.members) mentionedIds.add(rm.userId);
      }
    }

    // Fetch only members matching mentioned usernames
    if (userMentions.length > 0) {
      const usernames = [...new Set(userMentions.map(m => m.username))];
      const members = await prisma.serverMember.findMany({
        where: { serverId: data.serverId, user: { username: { in: usernames, mode: 'insensitive' } } },
        select: { userId: true, user: { select: { id: true, username: true, discriminator: true } } },
        take: 100,
      });
      for (const mention of userMentions) {
        const member = members.find(m =>
          m.user.username.toLowerCase() === mention.username &&
          (!mention.disc || m.user.discriminator === mention.disc),
        );
        if (member) mentionedIds.add(member.userId);
      }
    }

    mentionedIds.delete(data.authorId);

    if (mentionedIds.size > 0) {
      // Fetch author/channel info for push + persistent notifications. The
      // channel's `ageRestricted` flag drives the recipient filter below.
      const [authorUser, channel] = await Promise.all([
        prisma.user.findUnique({ where: { id: data.authorId }, select: { username: true } }),
        prisma.channel.findUnique({ where: { id: data.channelId }, select: { name: true, ageRestricted: true } }),
      ]);
      const authorName = authorUser?.username ?? 'Someone';
      const channelName = channel?.name ?? 'channel';
      const preview = data.content.length > 200 ? data.content.slice(0, 200) + '…' : data.content;

      // For age-gated channels, drop minors from the mention set so the
      // message preview never reaches them via push or Notification record.
      // Missing user rows fail-closed (treated as minors). Done before the
      // server-channel-activity emit so badge state stays consistent with
      // who actually receives the notification.
      if (channel?.ageRestricted) {
        const candidate = Array.from(mentionedIds);
        const ages = await prisma.user.findMany({
          where: { id: { in: candidate } },
          select: { id: true, dateOfBirth: true },
          take: candidate.length,
        });
        const adults = new Set(
          ages.filter(u => !isUnderEighteen(u.dateOfBirth)).map(u => u.id),
        );
        for (const uid of candidate) if (!adults.has(uid)) mentionedIds.delete(uid);
        if (mentionedIds.size === 0) {
          log.debug({ jobId: job.id, channelId: data.channelId }, 'all mention recipients dropped by age-gate');
          return;
        }
      }

      const mentionArray = Array.from(mentionedIds);
      _io.to(`server:${data.serverId}`).emit('server-channel-activity', {
        serverId: data.serverId,
        channelId: data.channelId,
        messageId: data.messageId,
        mentionUserIds: mentionArray,
      });

      // Filter out users who have this server in a muted folder
      let targetedMutedUserIds = new Set<string>();
      try {
        const mutedFolders = await prisma.serverFolder.findMany({
          where: { muted: true, serverIds: { has: data.serverId } },
          select: { userId: true },
          take: 50000,
        });
        targetedMutedUserIds = new Set(mutedFolders.map((f) => f.userId));
      } catch { /* fail open */ }

      // Send push notifications to mentioned users (skip connected + DND users)
      if (pushEnabled) {
        // Skip push for users who have active socket connections
        let mentionPushRecipients = mentionArray;
        if (_io) {
          const disconnected: string[] = [];
          for (const uid of mentionArray) {
            try {
              const sockets = await _io.in(`user:${uid}`).fetchSockets();
              if (sockets.length === 0) disconnected.push(uid);
            } catch {
              disconnected.push(uid); // fail open — send push if unsure
            }
          }
          mentionPushRecipients = disconnected;
        }
        if (mentionPushRecipients.length > 0) {
          const rateLimited = await checkNotifRateBatch(mentionPushRecipients);
          if (rateLimited.length > 0) {
            const [dndUsers, desktopDisabledUsers] = await Promise.all([
              prisma.user.findMany({ where: { id: { in: rateLimited }, status: 'dnd' }, select: { id: true }, take: 10000 }).catch(() => []),
              prisma.user.findMany({ where: { id: { in: rateLimited }, notifyDesktop: false }, select: { id: true }, take: 10000 }).catch(() => []),
            ]);
            const dndSet = new Set(dndUsers.map(u => u.id));
            const desktopDisabledSet = new Set(desktopDisabledUsers.map(u => u.id));
            const eligible = rateLimited.filter(uid => !dndSet.has(uid) && !targetedMutedUserIds.has(uid) && !desktopDisabledSet.has(uid));
            if (eligible.length > 0) {
              await sendPushToUsers(eligible, {
                title: `${authorName} mentioned you in #${channelName}`,
                body: preview,
                tag: `mention-${data.channelId}`,
                url: `/channels/${data.serverId}/${data.channelId}`,
              }).catch(err => log.warn({ err }, 'push mention fanout failed'));
            }
          }
        }
      }

      // Create persistent Notification records
      const notifTitle = `${authorName} mentioned you in #${channelName}`;
      prisma.notification.createMany({
        data: mentionArray.map(uid => ({
          userId: uid,
          serverId: data.serverId,
          channelId: data.channelId,
          type: 'mention',
          title: notifTitle,
          body: preview,
          metadata: { messageId: data.messageId, authorId: data.authorId, authorUsername: authorName, channelName },
        })),
      }).catch(() => {});

      // Increment ChannelReadState.mentionCount for mentioned users
      for (const uid of mentionArray) {
        prisma.channelReadState.upsert({
          where: { userId_channelId: { userId: uid, channelId: data.channelId } },
          create: { userId: uid, channelId: data.channelId, mentionCount: 1 },
          update: { mentionCount: { increment: 1 } },
        }).catch(() => {});
      }

      // Emit real-time notification to each mentioned user's personal room
      for (const uid of mentionArray) {
        _io.to(`user:${uid}`).emit('notification-created', {
          serverId: data.serverId,
          channelId: data.channelId,
          type: 'mention',
          title: notifTitle,
          body: preview,
          metadata: { messageId: data.messageId, authorId: data.authorId, authorUsername: authorName, channelName },
          createdAt: new Date().toISOString(),
        });
      }
    }
    log.debug({ jobId: job.id, mentions: mentionedIds.size }, 'mention fanout');
    return;
  }

  if (data.type === 'activity') {
    const [memberships, friendships, blocks, userPrivacy] = await Promise.all([
      prisma.serverMember.findMany({
        where: { userId: data.userId },
        select: { serverId: true, shareActivity: true, server: { select: { _count: { select: { members: true } } } } },
        take: 500,
      }).catch(() => [] as Array<{ serverId: string; shareActivity: boolean | null; server: { _count: { members: number } } }>),
      prisma.friendRequest.findMany({
        where: { status: 'accepted', OR: [{ fromUserId: data.userId }, { toUserId: data.userId }] },
        select: { fromUserId: true, toUserId: true },
        take: 2000,
      }).catch(() => []),
      prisma.block.findMany({
        where: { OR: [{ blockerId: data.userId }, { blockedUserId: data.userId }] },
        select: { blockerId: true, blockedUserId: true },
        take: 5000,
      }).catch(() => []),
      prisma.user.findUnique({
        where: { id: data.userId },
        select: { showCurrentActivity: true, activitySharingEnabled: true, activityShareScope: true },
      }).catch(() => null),
    ]);

    if (!userPrivacy || !userPrivacy.activitySharingEnabled) return;
    if (userPrivacy.showCurrentActivity === 'nobody') return;

    const blockedIds = new Set<string>();
    for (const b of blocks) {
      if (b.blockerId === data.userId) blockedIds.add(b.blockedUserId);
      else blockedIds.add(b.blockerId);
    }
    const friendIds = friendships
      .map(f => f.fromUserId === data.userId ? f.toUserId : f.fromUserId)
      .filter(fid => !blockedIds.has(fid));

    const payload = { userId: data.userId, activity: data.activity, secondaryActivity: data.secondaryActivity ?? null };
    const friendRooms = friendIds.map(fid => `user:${fid}`);

    const scope = userPrivacy.activityShareScope || 'everyone';
    const serverRooms: string[] = [];
    for (const m of memberships) {
      if (m.shareActivity === false) continue;
      if (m.shareActivity === true) { serverRooms.push(`server:${m.serverId}`); continue; }
      if (scope === 'everyone') { serverRooms.push(`server:${m.serverId}`); continue; }
      if (scope === 'friends_small_servers' && m.server._count.members <= 200) { serverRooms.push(`server:${m.serverId}`); continue; }
    }

    if (userPrivacy.showCurrentActivity === 'friends_only' || scope === 'friends_only') {
      if (friendRooms.length > 0) _io.to(friendRooms).emit('activity-update', payload);
      const overrideRooms = memberships.filter(m => m.shareActivity === true).map(m => `server:${m.serverId}`);
      if (overrideRooms.length > 0) _io.to(overrideRooms).emit('activity-update', payload);
    } else {
      const rooms = [...serverRooms, ...friendRooms];
      if (rooms.length > 0) _io.to(rooms).emit('activity-update', payload);
    }
    log.debug({ jobId: job.id, userId: data.userId, servers: serverRooms.length, friends: friendIds.length }, 'activity broadcast');
    return;
  }

  if (data.type === 'dm') {
    // Defense-in-depth: filter out blocked users before sending push notifications
    let filteredRecipientIds = data.recipientIds;
    if (data.authorId && filteredRecipientIds.length > 0) {
      const blocks = await prisma.block.findMany({
        where: {
          OR: [
            { blockerId: data.authorId, blockedUserId: { in: filteredRecipientIds } },
            { blockerId: { in: filteredRecipientIds }, blockedUserId: data.authorId },
          ],
        },
        select: { blockerId: true, blockedUserId: true },
        take: 10000,
      });
      if (blocks.length > 0) {
        const blockedUserIds = new Set(blocks.flatMap(b => [b.blockerId, b.blockedUserId]));
        filteredRecipientIds = filteredRecipientIds.filter(uid => !blockedUserIds.has(uid) || uid === data.authorId);
      }
    }

    if (pushEnabled && filteredRecipientIds.length > 0) {
      // Skip push for users who have active socket connections (they get in-app notifications)
      let pushRecipients = filteredRecipientIds;
      if (_io) {
        const disconnected: string[] = [];
        for (const uid of filteredRecipientIds) {
          try {
            const sockets = await _io.in(`user:${uid}`).fetchSockets();
            if (sockets.length === 0) disconnected.push(uid);
          } catch {
            disconnected.push(uid); // fail open — send push if unsure
          }
        }
        pushRecipients = disconnected;
      }
      if (pushRecipients.length === 0) return;

      const rateLimited = await checkNotifRateBatch(pushRecipients);
      if (rateLimited.length === 0) return;
      const [dndUsers, desktopDisabledUsers] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: rateLimited }, status: 'dnd' }, select: { id: true }, take: 10000 }).catch(() => []),
        prisma.user.findMany({ where: { id: { in: rateLimited }, notifyDesktop: false }, select: { id: true }, take: 10000 }).catch(() => []),
      ]);
      const dndSet = new Set(dndUsers.map(u => u.id));
      const desktopDisabledSet = new Set(desktopDisabledUsers.map(u => u.id));
      const eligible = rateLimited.filter(uid => !dndSet.has(uid) && !desktopDisabledSet.has(uid));
      if (eligible.length === 0) return;
      const author = await prisma.user.findUnique({
        where: { id: data.authorId },
        select: { username: true, avatar: true },
      });
      const authorName = author?.username ?? 'Someone';
      const body = data.encrypted
        ? 'Sent you an encrypted message'
        : (data.content.length > 100 ? data.content.slice(0, 100) + '…' : data.content);
      await sendPushToUsers(eligible, {
        title: `${authorName} sent you a message`,
        body,
        tag: `dm-${data.dmChannelId}`,
        url: `/dm/${data.dmChannelId}`,
        icon: author?.avatar ?? undefined,
      }).catch(err => log.warn({ err }, 'push DM notification failed'));
    }
    return;
  }
}

export function startNotificationWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;
  const worker = new Worker('notifications', processNotification, {
    connection: redisConnection,
    concurrency: 10,
    lockDuration: 30_000,
  });
  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // Strip `job.data` from dead-letter logs. Notification payloads can
      // carry userId and notification content; we keep only the job type
      // for triage.
      log.error({ jobId: job.id, err, type: (job.data as { type?: string } | undefined)?.type, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: notification job permanently failed after all retries');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'notification job failed (will retry)');
    }
  });
  log.info('notification worker started');
  return worker;
}
