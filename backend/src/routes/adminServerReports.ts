// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { adminServerReportsQuery, adminServerReportUpdateSchema } from '../schemas.js';
import { adminLimiter, logAction } from './adminHelpers.js';
import { logger } from '../logger.js';
import { z } from 'zod';

const log = logger.child({ module: 'adminServerReports' });
const router = Router();

// GET /api/v1/admin/server-reports?status=pending&page=1&limit=50
router.get(
  '/server-reports',
  adminLimiter,
  validate(adminServerReportsQuery),
  async (req, res: Response) => {
    const { page, limit, status } = req.query as unknown as z.infer<
      typeof adminServerReportsQuery
    >['query'];

    const where: Prisma.ServerReportWhereInput = {};
    if (status) where.status = status;

    const [reports, total] = await Promise.all([
      prisma.serverReport.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          server: { select: { id: true, name: true, icon: true } },
          reporter: { select: { id: true, username: true, discriminator: true, avatar: true } },
          reviewer: { select: { id: true, username: true, discriminator: true } },
        },
      }),
      prisma.serverReport.count({ where }),
    ]);

    res.json({
      reports,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
    });
  },
);

// PATCH /api/v1/admin/server-reports/:reportId
//
// Update a report's review state. This endpoint only RECORDS the intended
// action (`actionTaken`); the actual hide/suspend/remove enforcement lives in
// the admin server moderation routes. Admins follow up by calling those
// endpoints separately.
router.patch(
  '/server-reports/:reportId',
  adminLimiter,
  validateUuidParams('reportId'),
  validate(adminServerReportUpdateSchema),
  async (req, res: Response) => {
    const authReq = req as AdminAuthRequest;
    const reportId = req.params.reportId as string;
    const { status, actionTaken, reviewNote } = req.body as z.infer<
      typeof adminServerReportUpdateSchema
    >['body'];

    const report = await prisma.serverReport.findUnique({
      where: { id: reportId },
      select: { id: true, serverId: true, reporterId: true, status: true },
    });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const data: Prisma.ServerReportUpdateInput = { status };
    if (actionTaken !== undefined) data.actionTaken = actionTaken;
    if (reviewNote !== undefined) data.reviewNote = reviewNote;

    // Stamp reviewer/reviewedAt on any non-pending transition. Pending->pending
    // re-saves (e.g. reviewer adds a note then hits dismiss) still update the
    // review metadata so we always know who touched it last.
    if (status !== 'pending') {
      data.reviewer = { connect: { id: authReq.adminId! } };
      data.reviewedAt = new Date();
    }

    const updated = await prisma.serverReport.update({
      where: { id: reportId },
      data,
      include: {
        server: { select: { id: true, name: true, icon: true } },
        reporter: { select: { id: true, username: true, discriminator: true, avatar: true } },
        reviewer: { select: { id: true, username: true, discriminator: true } },
      },
    });

    await logAction(authReq.adminId!, 'server_report_review', null, {
      reportId,
      serverId: report.serverId,
      status: updated.status,
      actionTaken: updated.actionTaken,
    });

    if (
      actionTaken &&
      ['hide', 'suspend', 'remove'].includes(actionTaken)
    ) {
      log.warn(
        { reportId, serverId: report.serverId, actionTaken, adminId: authReq.adminId },
        'Server report flagged for enforcement — follow up via admin server moderation endpoints',
      );
    }

    res.json(updated);
  },
);

export default router;
