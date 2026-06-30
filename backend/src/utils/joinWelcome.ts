// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { prisma } from '../db.js';
import { pickDisplayRole } from './permissions.js';
import { invalidatePermissionContext } from '../redis.js';
import { logger } from '../logger.js';
const log = logger.child({ module: 'join-welcome' });

export async function applyAutoAssignRoles(serverId: string, userId: string): Promise<string[]> {
  const autoRoles = await prisma.serverAutoRole.findMany({ where: { serverId }, select: { roleId: true }, take: 5 });
  if (autoRoles.length === 0) return [];
  const granted: string[] = [];
  for (const { roleId } of autoRoles) {
    const r = await prisma.memberRole.upsert({
      where: { userId_serverId_roleId: { userId, serverId, roleId } },
      create: { userId, serverId, roleId, assignedBy: null }, update: {},
    }).catch((e) => { log.warn({ e, serverId, userId, roleId }, 'auto_assign_grant_failed'); return null; });
    if (r) granted.push(roleId);
  }
  const allRoles = await prisma.memberRole.findMany({
    where: { userId, serverId },
    include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true } } },
  });
  const display = pickDisplayRole(allRoles.map((mr) => mr.role));
  await prisma.serverMember.update({ where: { userId_serverId: { userId, serverId } }, data: { roleId: display?.id ?? null, role: display?.name ?? 'member' } });
  await invalidatePermissionContext(serverId, userId);
  return granted;
}

export async function postJoinWelcomeMessage(
  serverId: string,
  joiner: { id: string; username: string },
  io?: import('socket.io').Server,
): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({ where: { serverId } });
  if (!settings?.welcomeEnabled || !settings.welcomeMessage) return;

  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { name: true } });
  if (!server) return;

  let target = null as { id: string } | null;
  if (settings.welcomeChannelId) target = await prisma.channel.findFirst({ where: { id: settings.welcomeChannelId, serverId, type: 'text' }, select: { id: true } });
  if (!target) target = await prisma.channel.findFirst({ where: { serverId, type: 'text' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!target) return;

  const welcomeText = settings.welcomeMessage
    .replace(/{user}/g, joiner.username ?? 'someone')
    .replace(/{server}/g, server.name);

  try {
    const sysMsg = await prisma.message.create({
      data: {
        channelId: target.id,
        authorId: joiner.id,
        content: welcomeText,
        type: 'system',
        systemPayload: { kind: 'member_join' },
      },
    });

    if (io) {
      io.to(`channel:${target.id}`).emit('new-message', {
        ...sysMsg,
        createdAt: sysMsg.createdAt.toISOString(),
        editedAt: null,
        authorUsername: joiner.username ?? null,
        authorDiscriminator: null,
        authorAvatar: null,
        authorRoleColor: null,
        authorRoleStyle: 'solid',
        authorStripePlan: null,
        authorNameColor: null,
        authorNameFont: null,
        authorNameEffect: null,
        authorAvatarEffect: null,
        replyTo: null,
        attachmentUrl: null,
        attachmentName: null,
        attachmentContentType: null,
      });
    }
  } catch (err) {
    log.warn({ err, serverId }, 'join_welcome_post_failed');
  }
}
