// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { submitServerReportSchema } from '../schemas.js';
import { verifyCaptcha } from '../services/captcha.js';
import { sendServerReportReceivedEmail } from '../services/email.js';
import { getParam } from '../utils.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'serverReports' });
const router = Router();

// Admin SPA origin for the report CTA in the T&S notification email.
// Matches the convention used in `adminPasskey.ts` (CF Access protects the
// destination route, so this URL only resolves for authenticated admins).
const ADMIN_ORIGIN =
  process.env.ADMIN_ORIGIN?.split(',')[0]?.trim() || 'http://localhost:3001';

// 5 reports per 24h per user — matches MessageReport's 10/hour but applied to a
// rarer surface; server-level reports should be a deliberate action, not spam.
// Keyed by userId so an attacker can't burn the IP-based budget for everyone
// behind a shared NAT.
const submitServerReportLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-report:'),
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many server reports today. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// POST /api/v1/servers/:serverId/report
//
// User-submitted abuse report against an entire server. Captcha-gated to
// reduce automated dogpiling. Reports do NOT write AuditLog entries
// (reporter privacy — same stance as MessageReport).
router.post(
  '/:serverId/report',
  validateUuidParams('serverId'),
  authenticateToken,
  submitServerReportLimiter,
  validate(submitServerReportSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const body = req.body as z.infer<typeof submitServerReportSchema>['body'];

    const captchaOk = await verifyCaptcha(body.captchaToken, req.ip);
    if (!captchaOk) {
      return res.status(400).json({ error: 'CAPTCHA verification failed' });
    }

    const [server, existing, reporter] = await Promise.all([
      prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, name: true },
      }),
      // Dedupe — one pending report per (reporter, server). Run in parallel
      // with the existence check; both target indexed columns.
      prisma.serverReport.findFirst({
        where: { serverId, reporterId: req.userId, status: 'pending' },
        select: { id: true },
      }),
      // Reporter display name for the admin notification email. Server-side
      // only (we don't echo it back to the reporter or the reported server).
      prisma.user.findUnique({
        where: { id: req.userId },
        select: { username: true, discriminator: true },
      }),
    ]);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (existing) return res.status(409).json({ error: 'duplicate_pending' });

    const report = await prisma.serverReport.create({
      data: {
        serverId,
        reporterId: req.userId,
        reason: body.reason,
        details: body.details ?? null,
      },
      select: { id: true, status: true, createdAt: true },
    });

    log.info(
      { reportId: report.id, serverId, reason: body.reason },
      'Server report submitted',
    );

    // T&S notification — fire-and-forget. The sender no-ops cleanly when
    // ADMIN_NOTIFY_EMAIL is unset (dev/test) and we never fail the API
    // response on SMTP errors. The email body deliberately omits the
    // free-form `details` field (it could mirror DM contents in the worst
    // case) — reviewers click through to the admin panel for the full row.
    const reporterName = reporter
      ? `${reporter.username}#${reporter.discriminator}`
      : 'Unknown reporter';
    const reportUrl = `${ADMIN_ORIGIN}/server-reports?reportId=${report.id}`;
    sendServerReportReceivedEmail({
      adminName: 'Trust & Safety',
      serverName: server.name,
      reporterName,
      reason: body.reason,
      reportUrl,
    }).catch((err) =>
      log.warn(
        { err, reportId: report.id, serverId },
        'server_report_received_email_send_failed',
      ),
    );

    return res.status(201).json({
      id: report.id,
      status: report.status,
      createdAt: report.createdAt,
    });
  }),
);

export default router;
