// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin server T&S actions (Community/Public Servers).
 *
 * Mounted at `/api/v1/admin/servers/...` (separate from existing `admin.ts`
 * which owns `/admin/servers` *search*). Every endpoint:
 *
 *   - Goes through the `cfAccessAuth` + `authenticateAdminToken` chain
 *     (mounted at the parent in `server.ts`).
 *   - Validates body/params via `validate(zodSchema)`.
 *   - Writes BOTH an `AuditLog` row (per-server moderation history) AND a
 *     `ServerSuspension` row (admin-T&S audit feed). The two are written
 *     inside a single Prisma transaction with the state mutation so the
 *     audit trail can never desync from the server's `featured`/`verified`/
 *     `hiddenFromDiscovery`/`suspendedAt` columns.
 *   - Emits a Pino structured log with `serverId`, `adminId`, `action`.
 *
 * DM E2E sanctity (CRITICAL): suspending a server does NOT touch any DM
 * model, never inspects DM content, and never alters key bundles. Server
 * suspension only blocks state-changes against server channels (enforced
 * by the `serverNotSuspended` middleware on those routes).
 */

import { Router, Response, NextFunction, RequestHandler } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import {
  adminServerActionWithReasonSchema,
  adminServerHideSchema,
  adminServerSuspendSchema,
  adminDiscoveryQueueQuery,
} from '../schemas.js';
import { adminLimiter, logAction, UUID_REGEX, paramStr } from './adminHelpers.js';
import { AuditAction, type AuditActionValue } from '../constants/auditActions.js';
import { logger } from '../logger.js';
import {
  sendServerVerifiedEmail,
  sendServerSuspendedEmail,
  sendServerUnsuspendedEmail,
} from '../services/email.js';
import { decryptSecret } from '../services/mfaCrypto.js';

const log = logger.child({ module: 'adminServers' });
const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://howlpro.com';

const getServerIdParam = (req: AdminAuthRequest): string => paramStr(req.params.serverId);

/** Best-effort decrypt — emails are stored AES-encrypted at rest. */
function safeDecryptEmail(encrypted: string): string {
  try {
    return decryptSecret(encrypted);
  } catch {
    return encrypted;
  }
}

/**
 * Resolve the server owner's email + display name for admin-action emails.
 * Returns null if the server has no `role='owner'` member or the owner has
 * no email on file. Caller treats null as "skip email".
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

/** Fire-and-forget AdminAuditLog write. Never throws; logs failures via Pino. */
function recordAdminAction(
  adminId: string,
  action: string,
  serverId: string,
  reason: string | null,
): void {
  logAction(adminId, action, null, { serverId, reason }).catch((err) =>
    log.error({ err, serverId, adminId }, 'admin audit log write failed'),
  );
}

type ServerSuspensionAction =
  | 'suspend'
  | 'unsuspend'
  | 'hide'
  | 'unhide'
  | 'feature'
  | 'unfeature'
  | 'verify'
  | 'unverify'
  | 'grant_discovery_override'
  | 'revoke_discovery_override';

/**
 * Server-state mutation + AuditLog row + ServerSuspension row, all in one
 * transaction so the audit trail can never desync from the live state.
 *
 * `actorId` on both AuditLog and ServerSuspension is left null because
 * those columns FK to `User`, not `AdminUser`; the admin acts on behalf of
 * the platform. The acting admin's id is recorded in `details.adminId` and
 * separately written to AdminAuditLog by the calling route.
 */
async function persistAdminAction(params: {
  serverId: string;
  adminId: string;
  data: Prisma.ServerUpdateInput;
  suspensionAction: ServerSuspensionAction;
  auditAction: AuditActionValue;
  reason: string | null;
  details?: Record<string, unknown>;
}) {
  const { serverId, adminId, data, suspensionAction, auditAction, reason, details } = params;

  return prisma.$transaction([
    prisma.server.update({ where: { id: serverId }, data }),
    prisma.auditLog.create({
      data: {
        serverId,
        actorId: null,
        action: auditAction,
        targetType: 'server',
        targetId: serverId,
        details: { adminId, reason, ...(details ?? {}) } as Prisma.InputJsonValue,
      },
    }),
    prisma.serverSuspension.create({
      // actorId FKs to User, not AdminUser. Leave null and rely on
      // AdminAuditLog (written by the route) for admin attribution.
      data: { serverId, action: suspensionAction, actorId: null, reason },
    }),
  ]);
}

// Boolean-flip flag handlers
//
// `featured`, `verified`, `hiddenFromDiscovery` all flip a single boolean on
// `Server`. The handler shape is identical except for the column name, audit
// constants, and the body schema (hide requires a non-empty reason). Build
// each handler from a small spec instead of duplicating six near-identical
// route bodies.

type FlagAction = {
  field: 'featured' | 'verified' | 'hiddenFromDiscovery' | 'discoveryListingOverride';
  target: boolean;
  suspensionAction: ServerSuspensionAction;
  auditAction: AuditActionValue;
  prevDetailKey: string;
  logMessage: string;
};

function makeFlagHandler(action: FlagAction): RequestHandler {
  return async (req, res, next) => {
    try {
      const serverId = getServerIdParam(req as AdminAuthRequest);
      const reason = (req.body?.reason as string | undefined) ?? null;
      const adminId = (req as AdminAuthRequest).adminId!;

      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, [action.field]: true } as { id: true } & Record<string, true>,
      });
      if (!server) return res.status(404).json({ error: 'Server not found' });

      await persistAdminAction({
        serverId,
        adminId,
        data: { [action.field]: action.target },
        suspensionAction: action.suspensionAction,
        auditAction: action.auditAction,
        reason,
        details: { [action.prevDetailKey]: (server as Record<string, unknown>)[action.field] },
      });

      recordAdminAction(adminId, action.auditAction, serverId, reason);

      // Verify is the only flag-flip with a user-facing email.
      if (action.field === 'verified' && action.target === true) {
        getServerOwnerContact(serverId)
          .then((contact) => {
            if (!contact) return;
            return sendServerVerifiedEmail(contact.email, {
              ownerName: contact.displayName,
              serverName: contact.serverName,
              manageUrl: `${FRONTEND_URL}/server/${serverId}/settings`,
            });
          })
          .catch((err) =>
            log.error({ err, serverId }, 'sendServerVerifiedEmail failed'),
          );
      }

      log.info({ serverId, adminId }, action.logMessage);
      res.json({ ok: true, [action.field]: action.target });
    } catch (err) {
      log.error({ err }, `${action.logMessage} failed`);
      next(err);
    }
  };
}

router.post('/:serverId/feature', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'featured', target: true,
    suspensionAction: 'feature', auditAction: AuditAction.SERVER_FEATURE,
    prevDetailKey: 'previousFeatured', logMessage: 'admin feature' }));

router.post('/:serverId/unfeature', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'featured', target: false,
    suspensionAction: 'unfeature', auditAction: AuditAction.SERVER_UNFEATURE,
    prevDetailKey: 'previousFeatured', logMessage: 'admin unfeature' }));

router.post('/:serverId/verify', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'verified', target: true,
    suspensionAction: 'verify', auditAction: AuditAction.SERVER_VERIFY,
    prevDetailKey: 'previousVerified', logMessage: 'admin verify' }));

router.post('/:serverId/unverify', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'verified', target: false,
    suspensionAction: 'unverify', auditAction: AuditAction.SERVER_UNVERIFY,
    prevDetailKey: 'previousVerified', logMessage: 'admin unverify' }));

// `/hide` requires a non-empty reason (admin moderation accountability), so
// it uses a stricter body schema; the handler logic is otherwise identical.
router.post('/:serverId/hide', adminLimiter, validate(adminServerHideSchema),
  makeFlagHandler({ field: 'hiddenFromDiscovery', target: true,
    suspensionAction: 'hide', auditAction: AuditAction.SERVER_HIDE,
    prevDetailKey: 'previousHidden', logMessage: 'admin hide from discovery' }));

router.post('/:serverId/unhide', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'hiddenFromDiscovery', target: false,
    suspensionAction: 'unhide', auditAction: AuditAction.SERVER_UNHIDE,
    prevDetailKey: 'previousHidden', logMessage: 'admin unhide from discovery' }));

// Bypass the four quantitative discovery-listing gates (age, members,
// sustained engagement, retention) plus the icon/description asset gates.
// Community-mode safety prereqs are NOT bypassed — see migration comment.
router.post('/:serverId/grant-discovery-override', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'discoveryListingOverride', target: true,
    suspensionAction: 'grant_discovery_override', auditAction: AuditAction.SERVER_DISCOVERY_OVERRIDE_GRANT,
    prevDetailKey: 'previousDiscoveryOverride', logMessage: 'admin grant discovery listing override' }));

router.post('/:serverId/revoke-discovery-override', adminLimiter, validate(adminServerActionWithReasonSchema),
  makeFlagHandler({ field: 'discoveryListingOverride', target: false,
    suspensionAction: 'revoke_discovery_override', auditAction: AuditAction.SERVER_DISCOVERY_OVERRIDE_REVOKE,
    prevDetailKey: 'previousDiscoveryOverride', logMessage: 'admin revoke discovery listing override' }));

// Suspend / Unsuspend
//
// Different from the flag handlers: writes three columns (suspendedAt,
// suspensionReason, suspendedById) and conflict-checks the current state so
// the same admin can't double-suspend or unsuspend an already-active server.

router.post(
  '/:serverId/suspend',
  adminLimiter,
  validate(adminServerSuspendSchema),
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = getServerIdParam(req);
      const reason = (req.body?.reason as string | undefined) ?? null;
      const adminId = req.adminId!;

      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, suspendedAt: true },
      });
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (server.suspendedAt !== null) {
        return res.status(409).json({ error: 'Server is already suspended' });
      }

      await persistAdminAction({
        serverId,
        adminId,
        data: { suspendedAt: new Date(), suspensionReason: reason, suspendedById: adminId },
        suspensionAction: 'suspend',
        auditAction: AuditAction.SERVER_SUSPEND,
        reason,
      });

      recordAdminAction(adminId, AuditAction.SERVER_SUSPEND, serverId, reason);

      // Notify the owner. Fire-and-forget; suspension still takes effect even
      // if the email service is degraded.
      getServerOwnerContact(serverId)
        .then((contact) => {
          if (!contact) return;
          return sendServerSuspendedEmail(contact.email, {
            ownerName: contact.displayName,
            serverName: contact.serverName,
            reason: reason ?? 'No reason provided.',
            appealUrl: `${FRONTEND_URL}/appeal/server/${serverId}`,
          });
        })
        .catch((err) => log.error({ err, serverId }, 'sendServerSuspendedEmail failed'));

      log.warn({ serverId, adminId, reason }, 'admin server suspend');
      res.json({ ok: true, suspended: true });
    } catch (err) {
      log.error({ err }, 'admin suspend failed');
      next(err);
    }
  },
);

router.post(
  '/:serverId/unsuspend',
  adminLimiter,
  validate(adminServerActionWithReasonSchema),
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = getServerIdParam(req);
      const reason = (req.body?.reason as string | undefined) ?? null;
      const adminId = req.adminId!;

      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { id: true, suspendedAt: true },
      });
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (server.suspendedAt === null) {
        return res.status(409).json({ error: 'Server is not suspended' });
      }

      await persistAdminAction({
        serverId,
        adminId,
        data: { suspendedAt: null, suspensionReason: null, suspendedById: null },
        suspensionAction: 'unsuspend',
        auditAction: AuditAction.SERVER_UNSUSPEND,
        reason,
      });

      recordAdminAction(adminId, AuditAction.SERVER_UNSUSPEND, serverId, reason);

      getServerOwnerContact(serverId)
        .then((contact) => {
          if (!contact) return;
          return sendServerUnsuspendedEmail(contact.email, {
            ownerName: contact.displayName,
            serverName: contact.serverName,
          });
        })
        .catch((err) => log.error({ err, serverId }, 'sendServerUnsuspendedEmail failed'));

      log.info({ serverId, adminId }, 'admin server unsuspend');
      res.json({ ok: true, suspended: false });
    } catch (err) {
      log.error({ err }, 'admin unsuspend failed');
      next(err);
    }
  },
);

// Discovery review queue
//
// Newly community-enabled servers awaiting admin review: `communityEnabled=true`
// AND `discoverableSince > (now - 7d)`. Excludes already-hidden / suspended
// rows so the queue stays focused on actionable items. Bounded by `take ≤ 50`.

router.get(
  '/discovery-queue',
  adminLimiter,
  validate(adminDiscoveryQueueQuery),
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      // validate(adminDiscoveryQueueQuery) has already coerced these to bounded
      // numbers and written them back to req.query. The Express type is still
      // `string | string[] | ParsedQs`, so narrow defensively before arithmetic.
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
      const skip = (page - 1) * limit;

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const where: Prisma.ServerWhereInput = {
        suspendedAt: null,
        hiddenFromDiscovery: false,
        settings: {
          communityEnabled: true,
          discoverableSince: { gte: sevenDaysAgo },
        },
      };

      const [rows, total] = await Promise.all([
        prisma.server.findMany({
          where,
          select: {
            id: true,
            name: true,
            icon: true,
            featured: true,
            verified: true,
            createdAt: true,
            settings: {
              select: {
                category: true,
                language: true,
                discoverableSince: true,
                discoveryEnabled: true,
              },
            },
            _count: { select: { members: true } },
          },
          orderBy: { settings: { discoverableSince: 'desc' } },
          skip,
          take: limit,
        }),
        prisma.server.count({ where }),
      ]);

      res.json({
        servers: rows.map((s) => ({
          id: s.id,
          name: s.name,
          icon: s.icon,
          featured: s.featured,
          verified: s.verified,
          memberCount: s._count.members,
          category: s.settings?.category ?? null,
          language: s.settings?.language ?? null,
          discoveryEnabled: s.settings?.discoveryEnabled ?? false,
          discoverableSince: s.settings?.discoverableSince?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      log.error({ err }, 'admin discovery-queue failed');
      next(err);
    }
  },
);

// Admin-side insights summary
//
// `GET /admin/servers/:serverId/insights` — admin moderation view of server
// activity over the trailing 30-day window. Sources from `DailyServerStats`
// (populated nightly by the serverStats worker). Distinct from the owner-
// facing time-series endpoint at `/api/v1/servers/:serverId/insights` —
// that one returns per-day points; this one returns a single aggregated
// summary scoped for admin moderation context.
//
// DM E2E sanctity: aggregations cover Server / ServerMember / Channel /
// Message only. DM tables are explicitly excluded.

router.get(
  '/:serverId/insights',
  adminLimiter,
  async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = getServerIdParam(req);
      if (!UUID_REGEX.test(serverId)) {
        return res.status(400).json({ error: 'Invalid serverId' });
      }

      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: {
          id: true,
          settings: {
            select: {
              welcomeEnabled: true,
              communityEnabled: true,
              discoveryEnabled: true,
              rules: true,
            },
          },
        },
      });
      if (!server) return res.status(404).json({ error: 'Server not found' });

      const WINDOW_DAYS = 30;
      const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

      // Bounded ≤ 31 rows (one per UTC day in the window).
      const stats = await prisma.dailyServerStats.findMany({
        where: { serverId, date: { gte: since } },
        select: { joins: true, messages: true, retainedAfter7d: true, members: true },
        orderBy: { date: 'desc' },
        take: WINDOW_DAYS + 1,
      });

      const newJoins = stats.reduce((s, r) => s + r.joins, 0);
      const messagesSent = stats.reduce((s, r) => s + r.messages, 0);
      const retainedSum = stats.reduce((s, r) => s + r.retainedAfter7d, 0);
      const retentionRate = newJoins > 0 ? Math.min(retainedSum / newJoins, 1) : 0;

      // Active members: distinct authors over the window. groupBy aggregates
      // server-side; far cheaper than streaming rows. Pure read; no plaintext
      // DM exposure (Message is server-channel scoped).
      const activeAuthors = await prisma.message.groupBy({
        by: ['authorId'],
        where: {
          channel: { serverId },
          createdAt: { gte: since },
        },
        take: 50_000,
      });

      const settings = server.settings;
      const rulesArr = Array.isArray(settings?.rules) ? (settings!.rules as unknown[]) : [];
      const communityFeaturesActive = [
        settings?.welcomeEnabled,
        settings?.communityEnabled,
        settings?.discoveryEnabled,
        rulesArr.length > 0,
      ].filter(Boolean).length;

      res.json({
        serverId,
        windowDays: WINDOW_DAYS,
        activeMembers: activeAuthors.length,
        newJoins,
        messagesSent,
        retentionRate: Number(retentionRate.toFixed(4)),
        publicProfileVisits: 0, // not tracked yet
        communityFeaturesActive,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'admin server insights failed');
      next(err);
    }
  },
);

export default router;
