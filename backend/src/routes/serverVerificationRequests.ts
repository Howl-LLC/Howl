// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * "Verified by Howl" application — owner-facing routes.
 *
 * Mounted at `/api/v1/servers/:serverId/verification`. Server owners (only)
 * can submit, view, and withdraw a verification application. Admin review
 * lives in `routes/adminVerificationRequests.ts`.
 *
 * Patterns mirror serverApplications.ts (the apply-to-join flow):
 *   - validate(zodSchema) middleware (never inline safeParse)
 *   - createRateLimitStore() Redis-backed limiter (1/day per server)
 *   - 30-day cooldown after rejection (route-layer pre-check, returns 429)
 *   - audit log entry on every state-changing action
 *
 * Approval is admin-only (separate file). This file never sets
 * `Server.verified=true` — only the admin approve handler can.
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { validate } from '../middleware/validate.js';
import { getParam, loadPermissionContext } from '../utils.js';
import { submitVerificationRequestSchema } from '../schemas.js';
import { createAuditLog } from './serverSettings.js';
import { AuditAction } from '../constants/auditActions.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'serverVerificationRequests' });

const router = Router({ mergeParams: true });

// 30-day cooldown after a rejection before the same owner can re-apply for
// the same server. Surfaced to the UI as a countdown so owners know when
// they can try again.
const REJECTION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

const verifySubmitLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  windowMs: 24 * 60 * 60 * 1000,
  max: 1,
  store: createRateLimitStore('rl:verify-submit:'),
  keyGenerator: (req) => {
    const userId = (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous';
    return `${userId}:${getParam(req, 'serverId')}`;
  },
  message: { error: 'You can only submit one verification request per day per server.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyReadLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  windowMs: 60 * 1000,
  max: 60,
  store: createRateLimitStore('rl:verify-read:'),
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

type OwnerCtx = {
  userId: string;
  serverId: string;
};

/**
 * Resolve owner-only access. Reuses the same `role==='owner'` (case-
 * insensitive) check as `communityEligibility.findOwnerUserId`. Returns
 * null + sends a 403 if the requester isn't the server's owner.
 */
async function requireOwner(req: AuthRequest, res: Response): Promise<OwnerCtx | null> {
  if (!req.userId) {
    res.status(401).json({ error: 'Missing user' });
    return null;
  }
  const serverId = getParam(req, 'serverId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) {
    res.status(403).json({ error: 'Not a member of this server' });
    return null;
  }
  if (ctx.member.role?.toLowerCase() !== 'owner') {
    res.status(403).json({ error: 'Only the server owner can submit a verification request.' });
    return null;
  }
  return { userId: req.userId, serverId };
}

interface ResponseRequest {
  id: string;
  status: string;
  organizationName: string;
  websiteUrl: string;
  additionalNotes: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  /** Cooldown end timestamp when status === 'rejected'. Null otherwise. */
  cooldownUntil: string | null;
}

function shapeRequestForOwner(req: {
  id: string;
  status: string;
  organizationName: string;
  websiteUrl: string;
  additionalNotes: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}): ResponseRequest {
  const cooldownUntil =
    req.status === 'rejected' && req.decidedAt
      ? new Date(req.decidedAt.getTime() + REJECTION_COOLDOWN_MS).toISOString()
      : null;
  return {
    id: req.id,
    status: req.status,
    organizationName: req.organizationName,
    websiteUrl: req.websiteUrl,
    additionalNotes: req.additionalNotes,
    decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
    decisionNote: req.decisionNote,
    createdAt: req.createdAt.toISOString(),
    cooldownUntil,
  };
}

// GET — current verification status for this server
//
// Returns the owner's most recent request (any status) plus a server-level
// `alreadyVerified` flag for grandfathered admin-flipped servers. UI uses
// this to render either the apply form, a pending status panel, or
// "verified" / "rejected (cooldown)" states.

router.get(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  verifyReadLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireOwner(req, res);
      if (!m) return;

      const [latestRequest, server] = await Promise.all([
        prisma.serverVerificationRequest.findFirst({
          where: { serverId: m.serverId },
          orderBy: { createdAt: 'desc' },
          take: 1,
        }),
        prisma.server.findUnique({
          where: { id: m.serverId },
          select: { verified: true },
        }),
      ]);

      res.json({
        alreadyVerified: server?.verified === true,
        request: latestRequest ? shapeRequestForOwner(latestRequest) : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST — submit a verification request

router.post(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  verifySubmitLimiter,
  validate(submitVerificationRequestSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireOwner(req, res);
      if (!m) return;

      // Block resubmit if a previous request was rejected within the cooldown
      // window. Returned as 429 (the standard for rate-limit-style cooldowns)
      // with a `retryAfter` ISO timestamp so the UI can render a countdown.
      const lastRejected = await prisma.serverVerificationRequest.findFirst({
        where: { serverId: m.serverId, status: 'rejected' },
        orderBy: { decidedAt: 'desc' },
        select: { decidedAt: true },
      });
      if (lastRejected?.decidedAt) {
        const cooldownEnd = lastRejected.decidedAt.getTime() + REJECTION_COOLDOWN_MS;
        if (Date.now() < cooldownEnd) {
          return res.status(429).json({
            error: 'verification_cooldown',
            retryAfter: new Date(cooldownEnd).toISOString(),
          });
        }
      }

      // Block if already verified — owner doesn't need to re-apply.
      const server = await prisma.server.findUnique({
        where: { id: m.serverId },
        select: { verified: true },
      });
      if (server?.verified === true) {
        return res.status(409).json({ error: 'already_verified' });
      }

      // Block if a pending request from a *different* prior owner exists.
      // The unique constraint (serverId, submittedById, status) only covers
      // same-submitter duplicates — a different prior owner's pending row
      // can't be caught by the constraint, so the runtime check stays.
      // For same-submitter races (double-clicked submit button) we rely on
      // the unique constraint and translate P2002 to 409 below.
      //
      // NOTE: if an admin "unverify" flow lands later, consider whether a
      // 30-day cooldown should also apply to previously-approved requests
      // that were unverified — currently `lastRejected` only matches
      // status='rejected', so an approved-then-unverified server can
      // immediately resubmit.
      const pending = await prisma.serverVerificationRequest.findFirst({
        where: { serverId: m.serverId, status: 'pending' },
        select: { id: true },
      });
      if (pending) {
        return res.status(409).json({ error: 'pending_request_exists' });
      }

      const body = req.body as {
        organizationName: string;
        websiteUrl: string;
        additionalNotes?: string;
      };

      let created;
      try {
        created = await prisma.serverVerificationRequest.create({
          data: {
            serverId: m.serverId,
            submittedById: m.userId,
            organizationName: body.organizationName,
            websiteUrl: body.websiteUrl,
            additionalNotes: body.additionalNotes ?? null,
            status: 'pending',
          },
        });
      } catch (e) {
        // P2002 = Prisma unique-constraint violation. Means a concurrent
        // request from the same submitter slipped past the findFirst above
        // and won the create race. Return the same 409 the runtime check
        // would have, so the caller sees a consistent error shape.
        if (e instanceof Error && (e as { code?: string }).code === 'P2002') {
          return res.status(409).json({ error: 'pending_request_exists' });
        }
        throw e;
      }

      await createAuditLog(
        m.serverId,
        m.userId,
        AuditAction.SERVER_VERIFY_REQUEST_SUBMIT,
        'server',
        m.serverId,
        { requestId: created.id, organizationName: body.organizationName },
      );

      log.info(
        { serverId: m.serverId, userId: m.userId, requestId: created.id },
        'verification request submitted',
      );

      res.status(201).json(shapeRequestForOwner(created));
    } catch (err) {
      next(err);
    }
  },
);

// DELETE — withdraw a pending request

router.delete(
  '/me',
  validateUuidParams('serverId'),
  authenticateToken,
  verifyReadLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireOwner(req, res);
      if (!m) return;

      const pending = await prisma.serverVerificationRequest.findFirst({
        where: { serverId: m.serverId, submittedById: m.userId, status: 'pending' },
        select: { id: true },
      });
      if (!pending) {
        return res.status(404).json({ error: 'no_pending_request' });
      }

      const updated = await prisma.serverVerificationRequest.update({
        where: { id: pending.id },
        data: { status: 'withdrawn', decidedAt: new Date() },
      });

      await createAuditLog(
        m.serverId,
        m.userId,
        AuditAction.SERVER_VERIFY_REQUEST_WITHDRAW,
        'server',
        m.serverId,
        { requestId: updated.id },
      );

      log.info(
        { serverId: m.serverId, userId: m.userId, requestId: updated.id },
        'verification request withdrawn',
      );

      res.json(shapeRequestForOwner(updated));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
