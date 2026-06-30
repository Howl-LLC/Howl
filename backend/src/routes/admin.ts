// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { authenticateAdminToken, enforcePasswordChange, type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminServerSearchQuery, adminDataRequestsQuery, adminServerBansQuery, adminServerAuditQuery, adminServerAutomodQuery, adminServerSettingsQuery } from '../schemas.js';
import { z } from 'zod';

import { decryptSecret } from '../services/mfaCrypto.js';
import { logger } from '../logger.js';
import { EXPORTS_DIR } from '../exportsDir.js';
import { logAction, validateUuidParam, adminLimiter } from './adminHelpers.js';
import adminUserRoutes from './adminUsers.js';
import adminReportRoutes from './adminReports.js';
import adminServerReportRoutes from './adminServerReports.js';
import adminAnalyticsRoutes from './adminAnalytics.js';
import adminInviteRoutes from './adminInvites.js';
import adminForumRoutes from './adminForums.js';
import adminThreadRoutes from './adminThreads.js';
import adminPollRoutes from './adminPolls.js';

const log = logger.child({ module: 'admin' });
const router = Router();

router.use(authenticateAdminToken);
router.use(enforcePasswordChange);
// Prevent browsers/proxies from caching admin responses containing sensitive user data
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

router.use('/', adminUserRoutes);
router.use('/', adminReportRoutes);
router.use('/', adminServerReportRoutes);
router.use('/', adminAnalyticsRoutes);
router.use('/', adminInviteRoutes);
router.use('/', adminForumRoutes);
router.use('/', adminThreadRoutes);
router.use('/', adminPollRoutes);

const adminPowerUpBody = z.object({
  tier: z.number().int().min(0).max(3),
  durationMonths: z.number().int().min(0).max(36).optional(),
});
const adminPowerUpValidation = z.object({ body: adminPowerUpBody });

// GET /api/admin/stats
router.get('/stats', adminLimiter, async (_req: AdminAuthRequest, res: Response) => {
  const [userStats, serverStats, pendingReports] = await Promise.all([
    prisma.$queryRaw<[{
      totalUsers: bigint; onlineUsers: bigint; proUsers: bigint; essentialUsers: bigint;
      mfaUsers: bigint; unverifiedUsers: bigint; suspendedUsers: bigint;
      deactivatedUsers: bigint; trialUsers: bigint; newUsers24h: bigint;
    }]>`
      SELECT
        COUNT(*)::bigint AS "totalUsers",
        COUNT(*) FILTER (WHERE status != 'offline')::bigint AS "onlineUsers",
        COUNT(*) FILTER (WHERE "stripePlan" = 'pro')::bigint AS "proUsers",
        COUNT(*) FILTER (WHERE "stripePlan" = 'essential')::bigint AS "essentialUsers",
        COUNT(*) FILTER (WHERE "mfaEnabled" = true)::bigint AS "mfaUsers",
        COUNT(*) FILTER (WHERE "emailVerified" = false)::bigint AS "unverifiedUsers",
        COUNT(*) FILTER (WHERE suspended = true)::bigint AS "suspendedUsers",
        COUNT(*) FILTER (WHERE deactivated = true)::bigint AS "deactivatedUsers",
        COUNT(*) FILTER (WHERE "stripeStatus" = 'trialing')::bigint AS "trialUsers",
        COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '24 hours')::bigint AS "newUsers24h"
      FROM "User"
    `,
    prisma.server.count(),
    prisma.messageReport.count({ where: { status: 'pending' } }),
  ]);

  const s = userStats[0];
  res.json({
    totalUsers: Number(s.totalUsers),
    onlineUsers: Number(s.onlineUsers),
    proUsers: Number(s.proUsers),
    essentialUsers: Number(s.essentialUsers),
    mfaUsers: Number(s.mfaUsers),
    unverifiedUsers: Number(s.unverifiedUsers),
    suspendedUsers: Number(s.suspendedUsers),
    deactivatedUsers: Number(s.deactivatedUsers),
    trialUsers: Number(s.trialUsers),
    newUsers24h: Number(s.newUsers24h),
    totalServers: serverStats,
    pendingReports,
  });
});

// GET /api/admin/servers?q=...&page=1&limit=20&powerUpTier=...&minMembers=...
router.get('/servers', adminLimiter, validate(adminServerSearchQuery), async (req: AdminAuthRequest, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  const conditions: Prisma.ServerWhereInput[] = [];

  if (q) {
    conditions.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        ...(q.length === 36 ? [{ id: q }] : []),
      ],
    });
  }

  const puTier = parseInt(req.query.powerUpTier as string);
  if (!isNaN(puTier) && puTier >= 0 && puTier <= 3) {
    const tierThresholds = [
      { gte: 0, lt: 2 },   // T0: 0-1
      { gte: 2, lt: 7 },   // T1: 2-6
      { gte: 7, lt: 14 },  // T2: 7-13
      { gte: 14 },         // T3: 14+
    ];
    const t = tierThresholds[puTier];
    const powerUpWhere: Prisma.IntFilter = { gte: t.gte };
    if ('lt' in t) powerUpWhere.lt = t.lt;
    conditions.push({ powerUpCount: powerUpWhere });
  }

  const where: Prisma.ServerWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [servers, total] = await Promise.all([
    prisma.server.findMany({
      where,
      select: {
        id: true,
        name: true,
        icon: true,
        powerUpCount: true,
        createdAt: true,
        _count: { select: { members: true, channels: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.server.count({ where }),
  ]);

  res.json({
    servers: servers.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      powerUpCount: s.powerUpCount,
      powerUpTier: s.powerUpCount >= 14 ? 3 : s.powerUpCount >= 7 ? 2 : s.powerUpCount >= 2 ? 1 : 0,
      memberCount: s._count.members,
      channelCount: s._count.channels,
      createdAt: s.createdAt.toISOString(),
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// PATCH /api/admin/servers/:serverId/power-up-tier — set a server's power-up tier with optional duration
router.patch('/servers/:serverId/power-up-tier', adminLimiter, validate(adminPowerUpValidation), async (req: AdminAuthRequest, res: Response) => {
  const serverId = validateUuidParam(req.params.serverId);
  if (!serverId) return res.status(400).json({ error: 'Invalid serverId format' });

  const { tier, durationMonths } = req.body;

  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const countForTier = [0, 2, 7, 14][tier];
  const isPermanent = tier === 0 || !durationMonths || durationMonths === 0;
  let periodEnd: Date | null = null;
  if (tier > 0 && !isPermanent) {
    periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + durationMonths!);
  }

  await prisma.server.update({
    where: { id: serverId },
    data: {
      powerUpCount: countForTier,
      powerUpStatus: tier > 0 ? (isPermanent ? 'admin_granted' : 'active') : null,
      powerUpPeriodEnd: tier > 0 ? periodEnd : null,
    },
  });
  await logAction(req.adminId!, 'set_power_up_tier', serverId, {
    tier,
    powerUpCount: countForTier,
    permanent: tier > 0 ? isPermanent : false,
    durationMonths: tier > 0 && !isPermanent ? durationMonths : null,
    periodEnd: periodEnd?.toISOString() || null,
  });

  res.json({
    success: true,
    powerUpCount: countForTier,
    powerUpTier: tier,
    periodEnd: periodEnd?.toISOString() || null,
    permanent: tier > 0 ? isPermanent : false,
    powerUpStatus: tier > 0 ? (isPermanent ? 'admin_granted' : 'active') : null,
  });
});

// GET /api/admin/servers/:serverId — server detail
router.get('/servers/:serverId', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const serverId = validateUuidParam(req.params.serverId);
  if (!serverId) return res.status(400).json({ error: 'Invalid serverId format' });
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: {
      _count: { select: { members: true, channels: true, powerUps: true } },
      channels: { select: { id: true, name: true, type: true }, orderBy: { createdAt: 'asc' }, take: 200 },
      powerUps: {
        select: { id: true, createdAt: true, user: { select: { id: true, username: true, discriminator: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      },
      members: {
        select: { userId: true, role: true, roleId: true, joinedAt: true, user: { select: { id: true, username: true, discriminator: true, avatar: true, status: true } }, serverRole: { select: { id: true, name: true, color: true, position: true } } },
        orderBy: { joinedAt: 'asc' },
        take: 100,
      },
      roles: {
        select: { id: true, name: true, color: true, position: true, locked: true, _count: { select: { members: true } } },
        orderBy: { position: 'asc' },
        take: 250,
      },
    },
  });
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const puTier = server.powerUpCount >= 14 ? 3 : server.powerUpCount >= 7 ? 2 : server.powerUpCount >= 2 ? 1 : 0;
  res.json({
    id: server.id,
    name: server.name,
    icon: server.icon,
    banner: server.banner,
    powerUpCount: server.powerUpCount,
    powerUpTier: puTier,
    powerUpStatus: server.powerUpStatus || null,
    powerUpPeriodEnd: server.powerUpPeriodEnd?.toISOString() || null,
    memberCount: server._count.members,
    channelCount: server._count.channels,
    realPowerUpCount: server._count.powerUps,
    createdAt: server.createdAt.toISOString(),
    // T&S flag snapshot — consumed by the admin Server Actions page so its
    // action buttons render the correct Grant/Revoke label on first load
    // instead of starting from a stale all-false default.
    featured: server.featured,
    verified: server.verified,
    hiddenFromDiscovery: server.hiddenFromDiscovery,
    suspended: server.suspendedAt !== null,
    discoveryListingOverride: server.discoveryListingOverride,
    channels: server.channels,
    roles: server.roles.map((r: any) => ({ id: r.id, name: r.name, color: r.color, position: r.position, locked: r.locked, memberCount: r._count.members })),
    powerUps: server.powerUps.map((b: any) => ({ id: b.id, createdAt: b.createdAt.toISOString(), user: b.user })),
    members: server.members.map((m: any) => ({
      ...m.user,
      role: m.role,
      serverRole: m.serverRole ? { id: m.serverRole.id, name: m.serverRole.name, color: m.serverRole.color, position: m.serverRole.position } : null,
      joinedAt: m.joinedAt?.toISOString() || null,
    })),
  });
});

// Server Moderation (read-only)

// GET /api/admin/servers/:serverId/settings
router.get('/servers/:serverId/settings', adminLimiter, validate(adminServerSettingsQuery), async (req: AdminAuthRequest, res: Response) => {
  const serverId = validateUuidParam(req.params.serverId);
  if (!serverId) return res.status(400).json({ error: 'Invalid serverId format' });

  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const settings = await prisma.serverSettings.findUnique({ where: { serverId } });

  await logAction(req.adminId!, 'view_server_settings', null, { serverId });
  res.json({ settings: settings || null });
});

// GET /api/admin/servers/:serverId/bans
router.get('/servers/:serverId/bans', adminLimiter, validate(adminServerBansQuery), async (req: AdminAuthRequest, res: Response) => {
  const serverId = validateUuidParam(req.params.serverId);
  if (!serverId) return res.status(400).json({ error: 'Invalid serverId format' });

  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = 50;
  const skip = (page - 1) * limit;

  const [bans, total] = await Promise.all([
    prisma.serverBan.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.serverBan.count({ where: { serverId } }),
  ]);

  // Resolve user info for banned users and banners
  const userIds = [...new Set(bans.flatMap(b => [b.userId, b.bannedById]))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, discriminator: true, avatar: true },
        take: 200,
      })
    : [];
  const userMap = new Map(users.map(u => [u.id, u]));

  await logAction(req.adminId!, 'view_server_bans', null, { serverId });
  res.json({
    bans: bans.map(b => ({
      id: b.id,
      userId: b.userId,
      reason: b.reason,
      createdAt: b.createdAt.toISOString(),
      user: userMap.get(b.userId) || null,
      bannedBy: userMap.get(b.bannedById) || null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// GET /api/admin/servers/:serverId/audit-log
router.get('/servers/:serverId/audit-log', adminLimiter, validate(adminServerAuditQuery), async (req: AdminAuthRequest, res: Response) => {
  const serverId = validateUuidParam(req.params.serverId);
  if (!serverId) return res.status(400).json({ error: 'Invalid serverId format' });

  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const actionFilter = (req.query.action as string) || undefined;
  const limit = 50;
  const skip = (page - 1) * limit;

  const where: Prisma.AuditLogWhereInput = { serverId };
  if (actionFilter) where.action = actionFilter;

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Resolve actor info (actorId is nullable — SetNull on user delete)
  const actorIds = [...new Set(entries.map(e => e.actorId).filter((id): id is string => id !== null))];
  const actors = actorIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, username: true, avatar: true },
        take: 200,
      })
    : [];
  const actorMap = new Map(actors.map(u => [u.id, u]));

  await logAction(req.adminId!, 'view_server_audit_log', null, { serverId });
  res.json({
    entries: entries.map(e => ({
      id: e.id,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      details: e.details,
      createdAt: e.createdAt.toISOString(),
      actor: e.actorId ? (actorMap.get(e.actorId) || null) : null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// GET /api/admin/servers/:serverId/automod-rules
router.get('/servers/:serverId/automod-rules', adminLimiter, validate(adminServerAutomodQuery), async (req: AdminAuthRequest, res: Response) => {
  const serverId = validateUuidParam(req.params.serverId);
  if (!serverId) return res.status(400).json({ error: 'Invalid serverId format' });

  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const rules = await prisma.automodRule.findMany({
    where: { serverId },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  await logAction(req.adminId!, 'view_server_automod_rules', null, { serverId });
  res.json({ rules });
});

// Data Export Requests

router.get('/data-requests', adminLimiter, validate(adminDataRequestsQuery), async (req: AdminAuthRequest, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = 20;
  const statusFilter = (req.query.status as string) || undefined;

  const where: any = {};
  if (statusFilter) where.status = statusFilter;

  const [requests, total] = await Promise.all([
    prisma.dataExportRequest.findMany({
      where,
      include: { user: { select: { id: true, username: true, discriminator: true, email: true, avatar: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.dataExportRequest.count({ where }),
  ]);

  const decryptEmail = (enc: string) => { try { return decryptSecret(enc); } catch { return enc; } };

  res.json({
    requests: requests.map(r => ({
      id: r.id,
      userId: r.userId,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() || null,
      error: r.error,
      user: {
        id: r.user.id,
        username: r.user.username,
        discriminator: r.user.discriminator,
        email: decryptEmail(r.user.email),
        avatar: r.user.avatar,
      },
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

router.post('/data-requests/:requestId/approve', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const requestId = validateUuidParam(req.params.requestId);
  if (!requestId) return res.status(400).json({ error: 'Invalid requestId format' });

  const request = await prisma.dataExportRequest.findUnique({ where: { id: requestId } });
  if (!request) return res.status(404).json({ error: 'Request not found' });

  if (request.status === 'ready') {
    return res.status(400).json({ error: 'Export is already ready' });
  }
  if (request.status === 'processing') {
    return res.status(400).json({ error: 'Export is already being processed' });
  }

  await prisma.dataExportRequest.update({
    where: { id: requestId },
    data: { status: 'pending', error: null },
  });

  const { enqueueDataExport } = await import('../queues/producers.js');
  await enqueueDataExport({ requestId: request.id, userId: request.userId });

  log.info({ adminId: req.adminId, requestId }, 'admin approved data export request');
  await logAction(req.adminId!, 'approve_data_export', request.userId, { requestId });

  res.json({ success: true });
});

router.delete('/data-requests/:requestId', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const requestId = validateUuidParam(req.params.requestId);
  if (!requestId) return res.status(400).json({ error: 'Invalid requestId format' });

  const request = await prisma.dataExportRequest.findUnique({ where: { id: requestId } });
  if (!request) return res.status(404).json({ error: 'Request not found' });

  if (request.filePath) {
    const fs = await import('fs');
    const path = await import('path');
    const exportsBaseDir = EXPORTS_DIR;
    const safePath = path.resolve(request.filePath);
    if (!safePath.startsWith(path.resolve(exportsBaseDir) + path.sep) && safePath !== path.resolve(exportsBaseDir)) {
      return res.status(403).json({ error: 'Invalid file path' });
    }
    try { fs.unlinkSync(safePath); } catch { /* file may already be gone */ }
  }

  await prisma.dataExportRequest.delete({ where: { id: requestId } });

  await logAction(req.adminId!, 'delete_data_export', request.userId, { requestId, hadFile: !!request.filePath, status: request.status });
  log.info({ adminId: req.adminId, requestId }, 'admin deleted data export request');
  res.json({ success: true });
});

export default router;
