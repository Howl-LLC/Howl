// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin review routes for "Verified by Howl" applications.
 *
 * Mounted at `/api/v1/admin/verification-requests`. Goes through the full
 * admin chain (cfAccessAuth + admin JWT + force-password-change gate) at
 * mount time in server.ts.
 *
 * Approval is the only path that flips `Server.verified=true`. Owners and
 * moderators have no other way to grant the badge.
 *
 * Approval atomically:
 *   1. Updates ServerVerificationRequest (status='approved', reviewerId, decidedAt, decisionNote)
 *   2. Sets Server.verified=true (the actual badge state)
 *   3. Writes AuditLog (per-server moderation history)
 *   4. Writes ServerSuspension row (admin T&S audit feed, action='verify')
 *   5. Writes AdminAuditLog (cross-platform admin attribution)
 *   6. Fire-and-forget email to the owner (sendServerVerifiedEmail).
 *
 * Rejection updates the request only — server.verified is untouched.
 * Triggers a 30-day cooldown before the same owner can resubmit (enforced
 * in serverVerificationRequests.ts at submit time).
 */

import { Router, Response, NextFunction } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import {
  decideVerificationRequestSchema,
  listVerificationRequestsQuery,
} from '../schemas.js';
import { adminLimiter, logAction, paramStr } from './adminHelpers.js';
import { AuditAction } from '../constants/auditActions.js';
import { logger } from '../logger.js';
import {
  sendServerVerifiedEmail,
  sendServerVerificationRejectedEmail,
} from '../services/email.js';
import { decryptSecret } from '../services/mfaCrypto.js';

const log = logger.child({ module: 'adminVerificationRequests' });
const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://howlpro.com';
const REJECTION_COOLDOWN_DAYS = 30;

function safeDecryptEmail(encrypted: string): string {
  try {
    return decryptSecret(encrypted);
  } catch {
    return encrypted;
  }
}

/**
 * Resolve owner email + display name. Mirrors `adminServers.ts`
 * getServerOwnerContact (kept private there, intentionally re-implemented
 * here so the two files don't have a circular dependency through helpers).
 */
async function getServerOwnerContact(
  serverId: string,
): Promise<{ email: string; displayName: string; serverName: string } | null> {
  const owner = await prisma.serverMember.findFirst({
    where: { serverId, role: 'owner' },
    select: {
      user: { select: { email: true, username: true } },
      server: { select: { name: true } },
    },
  });
  if (!owner?.user?.email) return null;
  const email = safeDecryptEmail(owner.user.email);
  if (!email) return null;
  return {
    email,
    displayName: owner.user.username || 'there',
    serverName: owner.server.name,
  };
}

// List queue
//
// Default lists pending requests (admin queue hot path), ordered oldest-
// first so the oldest unreviewed request gets reviewed next. Page size
// capped at 50 by the schema.

router.get(
  '/',
  adminLimiter,
  validate(listVerificationRequestsQuery),
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const status = (req.query.status as string | undefined) ?? 'pending';
      const page = Math.max(Number(req.query.page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 50);
      const skip = (page - 1) * pageSize;

      const where: Prisma.ServerVerificationRequestWhereInput = { status };

      const [rows, total] = await Promise.all([
        prisma.serverVerificationRequest.findMany({
          where,
          orderBy: { createdAt: 'asc' }, // oldest pending first
          skip,
          take: pageSize,
          include: {
            server: {
              select: {
                id: true,
                name: true,
                icon: true,
                verified: true,
                createdAt: true,
                _count: { select: { members: true } },
              },
            },
            submitter: {
              select: { id: true, username: true, discriminator: true, avatar: true },
            },
          },
        }),
        prisma.serverVerificationRequest.count({ where }),
      ]);

      res.json({
        requests: rows.map((r) => ({
          id: r.id,
          status: r.status,
          organizationName: r.organizationName,
          websiteUrl: r.websiteUrl,
          additionalNotes: r.additionalNotes,
          decidedAt: r.decidedAt?.toISOString() ?? null,
          decisionNote: r.decisionNote,
          createdAt: r.createdAt.toISOString(),
          server: {
            id: r.server.id,
            name: r.server.name,
            icon: r.server.icon,
            alreadyVerified: r.server.verified,
            createdAt: r.server.createdAt.toISOString(),
            memberCount: r.server._count.members,
          },
          submitter: {
            id: r.submitter.id,
            username: r.submitter.username,
            discriminator: r.submitter.discriminator,
            avatar: r.submitter.avatar,
          },
        })),
        total,
        page,
        pages: Math.ceil(total / pageSize),
      });
    } catch (err) {
      next(err);
    }
  },
);

// Approve

router.post(
  '/:requestId/approve',
  adminLimiter,
  validate(decideVerificationRequestSchema),
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = paramStr(req.params.requestId);
      const adminId = req.adminId!;
      const decisionNote = (req.body?.decisionNote as string | undefined) ?? null;

      const request = await prisma.serverVerificationRequest.findUnique({
        where: { id: requestId },
        select: { id: true, serverId: true, status: true },
      });
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (request.status !== 'pending') {
        return res.status(409).json({ error: 'Request is not pending' });
      }

      // Check current verified state to record in audit details.
      const server = await prisma.server.findUnique({
        where: { id: request.serverId },
        select: { id: true, verified: true },
      });
      if (!server) return res.status(404).json({ error: 'Server not found' });

      // Atomic: update request → flip server.verified → write per-server
      // audit row → write T&S suspension feed row.
      // Same shape as adminServers.ts persistAdminAction so the audit feed
      // stays consistent with admin-flipped verifications.
      await prisma.$transaction([
        prisma.serverVerificationRequest.update({
          where: { id: requestId },
          data: {
            status: 'approved',
            reviewerId: adminId,
            decidedAt: new Date(),
            decisionNote,
          },
        }),
        prisma.server.update({
          where: { id: request.serverId },
          data: { verified: true },
        }),
        prisma.auditLog.create({
          data: {
            serverId: request.serverId,
            actorId: null, // admins live in AdminUser, not User
            action: AuditAction.SERVER_VERIFY,
            targetType: 'server',
            targetId: request.serverId,
            details: {
              adminId,
              requestId,
              previousVerified: server.verified,
              decisionNote,
            } as Prisma.InputJsonValue,
          },
        }),
        prisma.serverSuspension.create({
          data: {
            serverId: request.serverId,
            action: 'verify',
            actorId: null,
            reason: decisionNote,
          },
        }),
      ]);

      // AdminAuditLog (cross-platform admin attribution) — fire-and-forget.
      logAction(adminId, AuditAction.SERVER_VERIFY_REQUEST_APPROVE, null, {
        serverId: request.serverId,
        requestId,
        decisionNote,
      }).catch((err) =>
        log.error({ err, serverId: request.serverId, adminId }, 'admin audit log write failed'),
      );

      // Owner email — fire-and-forget.
      getServerOwnerContact(request.serverId)
        .then((contact) => {
          if (!contact) return;
          return sendServerVerifiedEmail(contact.email, {
            ownerName: contact.displayName,
            serverName: contact.serverName,
            manageUrl: `${FRONTEND_URL}/server/${request.serverId}/settings`,
          });
        })
        .catch((err) =>
          log.error({ err, serverId: request.serverId }, 'sendServerVerifiedEmail failed'),
        );

      log.info(
        { serverId: request.serverId, adminId, requestId },
        'verification request approved',
      );

      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'verification approve failed');
      next(err);
    }
  },
);

// Reject

router.post(
  '/:requestId/reject',
  adminLimiter,
  validate(decideVerificationRequestSchema),
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = paramStr(req.params.requestId);
      const adminId = req.adminId!;
      const decisionNote = (req.body?.decisionNote as string | undefined) ?? null;

      const request = await prisma.serverVerificationRequest.findUnique({
        where: { id: requestId },
        select: { id: true, serverId: true, status: true },
      });
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (request.status !== 'pending') {
        return res.status(409).json({ error: 'Request is not pending' });
      }

      await prisma.serverVerificationRequest.update({
        where: { id: requestId },
        data: {
          status: 'rejected',
          reviewerId: adminId,
          decidedAt: new Date(),
          decisionNote,
        },
      });

      logAction(adminId, AuditAction.SERVER_VERIFY_REQUEST_REJECT, null, {
        serverId: request.serverId,
        requestId,
        decisionNote,
      }).catch((err) =>
        log.error({ err, serverId: request.serverId, adminId }, 'admin audit log write failed'),
      );

      // Owner notification — fire-and-forget.
      getServerOwnerContact(request.serverId)
        .then((contact) => {
          if (!contact) return;
          return sendServerVerificationRejectedEmail(contact.email, {
            ownerName: contact.displayName,
            serverName: contact.serverName,
            decisionNote: decisionNote ?? undefined,
            cooldownDays: REJECTION_COOLDOWN_DAYS,
          });
        })
        .catch((err) =>
          log.error({ err, serverId: request.serverId }, 'sendServerVerificationRejectedEmail failed'),
        );

      log.info(
        { serverId: request.serverId, adminId, requestId },
        'verification request rejected',
      );

      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'verification reject failed');
      next(err);
    }
  },
);

export default router;
