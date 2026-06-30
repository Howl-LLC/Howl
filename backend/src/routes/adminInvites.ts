// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminInvitesQuery } from '../schemas.js';
import { adminLimiter } from './adminHelpers.js';

const router = Router();

// GET /api/admin/invites
router.get('/invites', adminLimiter, validate(adminInvitesQuery), async (req: AdminAuthRequest, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = 50;
  const skip = (page - 1) * limit;

  const conditions: Prisma.InviteWhereInput[] = [];

  if (q) {
    conditions.push({
      OR: [
        { code: { contains: q, mode: 'insensitive' } },
        { server: { name: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }

  const where: Prisma.InviteWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  // Resolve inviter info separately since Invite has no direct User relation
  const [invites, total] = await Promise.all([
    prisma.invite.findMany({
      where,
      include: {
        server: { select: { id: true, name: true, icon: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.invite.count({ where }),
  ]);

  // Resolve inviter user info
  const inviterIds = [...new Set(invites.map(i => i.createdById))];
  const inviters = inviterIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: inviterIds } },
        select: { id: true, username: true, discriminator: true, avatar: true },
        take: 50,
      })
    : [];
  const inviterMap = new Map(inviters.map(u => [u.id, u]));

  res.json({
    invites: invites.map(i => ({
      id: i.id,
      code: i.code,
      serverId: i.serverId,
      expiresAt: i.expiresAt?.toISOString() || null,
      maxUses: i.maxUses,
      useCount: i.useCount,
      temporary: i.temporary,
      createdAt: i.createdAt.toISOString(),
      server: i.server,
      inviter: inviterMap.get(i.createdById) || null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

export default router;
