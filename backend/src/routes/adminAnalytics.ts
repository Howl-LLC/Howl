// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminAnalyticsQuery, adminProtocolDistributionQuery } from '../schemas.js';
import { adminLimiter } from './adminHelpers.js';
import { getIO } from '../socketIO.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'adminAnalytics' });
const router = Router();

const RANGE_HOURS: Record<string, number> = {
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
  '3mo': 90 * 24,
  '6mo': 180 * 24,
};

// GET /api/admin/analytics
router.get('/analytics', adminLimiter, validate(adminAnalyticsQuery), async (req: AdminAuthRequest, res: Response) => {
  try {
    const range = (req.query.range as string) || '24h';
    const hours = RANGE_HOURS[range] || 24;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    let snapshots: any[];

    if (range === '30d' || range === '3mo' || range === '6mo') {
      // Aggregate to daily averages for longer ranges
      const raw = await prisma.$queryRaw<any[]>`
        SELECT
          DATE("timestamp") AS "date",
          "region",
          ROUND(AVG("onlineCount"))::int AS "onlineCount"
        FROM "AnalyticsSnapshot"
        WHERE "timestamp" >= ${cutoff}
        GROUP BY DATE("timestamp"), "region"
        ORDER BY DATE("timestamp") ASC, "region" ASC
      `;
      // $queryRaw may return BigInt for aggregated values — coerce to Number for JSON serialization
      snapshots = raw.map(r => ({
        ...r,
        onlineCount: typeof r.onlineCount === 'bigint' ? Number(r.onlineCount) : r.onlineCount,
      }));
    } else {
      snapshots = await prisma.analyticsSnapshot.findMany({
        where: { timestamp: { gte: cutoff } },
        orderBy: { timestamp: 'asc' },
        take: 50000,
      });
    }

    // Get current online counts by region from Socket.IO
    const currentByRegion: Record<string, number> = {};
    let totalOnline = 0;
    try {
      const sockets = await getIO().sockets.fetchSockets();
      totalOnline = sockets.length;
      for (const socket of sockets) {
        const region = (socket.data?.region as string) || 'unknown';
        currentByRegion[region] = (currentByRegion[region] || 0) + 1;
      }
    } catch (err) {
      log.warn({ err }, 'Failed to fetch socket count for analytics');
    }

    res.json({
      snapshots,
      currentByRegion,
      totalOnline,
    });
  } catch (err: any) {
    // Table may not exist yet if migration hasn't been run
    if (err?.code === 'P2021' || err?.message?.includes('does not exist')) {
      log.warn('AnalyticsSnapshot table not found — returning empty data. Run prisma migrate deploy.');
      return res.json({ snapshots: [], currentByRegion: {}, totalOnline: 0 });
    }
    log.error({ err }, 'Failed to fetch analytics data');
    res.status(500).json({ error: 'Failed to load analytics data' });
  }
});

const PROTOCOL_RANGE_HOURS: Record<string, number> = {
  '24h': 24,
  '7d': 7 * 24,
  '14d': 14 * 24,
  '30d': 30 * 24,
  '60d': 60 * 24,
};

// GET /api/admin/analytics/protocol-distribution
router.get(
  '/analytics/protocol-distribution',
  adminLimiter,
  validate(adminProtocolDistributionQuery),
  async (req: AdminAuthRequest, res: Response) => {
    try {
      const range = (req.query.range as string) || '14d';
      const thresholdBuildDate = req.query.thresholdBuildDate as string | undefined;
      const hours = PROTOCOL_RANGE_HOURS[range] || 14 * 24;
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

      let snapshots: Array<{
        timestamp: Date | string;
        buildDate: string | null;
        platform: string;
        protocolVersion: number | null;
        count: number;
      }>;

      if (range === '30d' || range === '60d') {
        const raw = await prisma.$queryRaw<Array<{
          date: string;
          buildDate: string | null;
          platform: string;
          protocolVersion: number | null;
          count: bigint;
        }>>`
          SELECT
            DATE("timestamp") AS "date",
            "buildDate",
            "platform",
            "protocolVersion",
            SUM("count") AS "count"
          FROM "ProtocolDistributionSnapshot"
          WHERE "timestamp" >= ${cutoff}
          GROUP BY DATE("timestamp"), "buildDate", "platform", "protocolVersion"
          ORDER BY DATE("timestamp") ASC
        `;
        snapshots = raw.map(r => ({
          timestamp: r.date,
          buildDate: r.buildDate,
          platform: r.platform,
          protocolVersion: r.protocolVersion,
          count: typeof r.count === 'bigint' ? Number(r.count) : r.count,
        }));
      } else {
        snapshots = await prisma.protocolDistributionSnapshot.findMany({
          where: { timestamp: { gte: cutoff } },
          orderBy: { timestamp: 'asc' },
          take: 50000,
        });
      }

      // Live current-state: iterate fetchSockets() and group right now.
      const byPlatform: Record<string, { total: number; byBuildDate: Record<string, number> }> = {
        electron: { total: 0, byBuildDate: {} },
        web: { total: 0, byBuildDate: {} },
        unknown: { total: 0, byBuildDate: {} },
      };
      let atOrAboveThreshold:
        | Record<string, { total: number; meeting: number; pct: number }>
        | undefined;

      try {
        const sockets = await getIO().sockets.fetchSockets();
        if (thresholdBuildDate) {
          atOrAboveThreshold = {
            electron: { total: 0, meeting: 0, pct: 0 },
            web: { total: 0, meeting: 0, pct: 0 },
            unknown: { total: 0, meeting: 0, pct: 0 },
          };
        }
        for (const socket of sockets) {
          const ctx = socket.data?.protocolContext as { buildDate: string | null } | undefined;
          const buildDate = ctx?.buildDate ?? 'null';
          const ua = (socket.handshake.headers['user-agent'] as string | undefined) ?? '';
          const platform = /Electron\//.test(ua) ? 'electron' : (ua ? 'web' : 'unknown');
          const slot = byPlatform[platform];
          slot.total += 1;
          slot.byBuildDate[buildDate] = (slot.byBuildDate[buildDate] ?? 0) + 1;
          if (atOrAboveThreshold && thresholdBuildDate) {
            const meets = buildDate !== 'null' && buildDate >= thresholdBuildDate;
            atOrAboveThreshold[platform].total += 1;
            if (meets) atOrAboveThreshold[platform].meeting += 1;
          }
        }
        if (atOrAboveThreshold) {
          for (const p of ['electron', 'web', 'unknown']) {
            const slot = atOrAboveThreshold[p];
            slot.pct = slot.total === 0 ? 0 : Math.round((slot.meeting / slot.total) * 1000) / 10;
          }
        }
      } catch (err) {
        log.warn({ err }, 'Failed to fetch live sockets for protocol distribution');
      }

      res.json({
        snapshots,
        current: {
          byPlatform,
          ...(atOrAboveThreshold ? { atOrAboveThreshold } : {}),
        },
      });
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string };
      if (errorObj?.code === 'P2021' || errorObj?.message?.includes('does not exist')) {
        log.warn('ProtocolDistributionSnapshot table not found — returning empty data. Run prisma migrate deploy.');
        return res.json({ snapshots: [], current: { byPlatform: { electron: { total: 0, byBuildDate: {} }, web: { total: 0, byBuildDate: {} }, unknown: { total: 0, byBuildDate: {} } } } });
      }
      log.error({ err }, 'Failed to fetch protocol distribution data');
      res.status(500).json({ error: 'Failed to fetch protocol distribution' });
    }
  }
);

export default router;
