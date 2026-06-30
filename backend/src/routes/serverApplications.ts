// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest, JWT_SECRET } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import {
  updateApplicationQuestionsSchema,
  getApplicationQuestionsSchema,
  submitApplicationSchema,
  withdrawApplicationSchema,
  listApplicationsSchema,
  decideApplicationSchema,
} from '../schemas.js';
import { verifyCaptcha } from '../services/captcha.js';
import {
  sendApplicationAcceptedEmail,
  sendApplicationRejectedEmail,
} from '../services/email.js';
import { decryptSecret } from '../services/mfaCrypto.js';
import { logger } from '../logger.js';
import { createAuditLog } from './serverSettings.js';
import { isPubliclyDiscoverable } from '../utils/communityEligibility.js';
import { getClientIp } from '../utils/clientIp.js';
import { invalidatePermissionContext } from '../redis.js';
import { applyAutoAssignRoles, postJoinWelcomeMessage } from '../utils/joinWelcome.js';

const log = logger.child({ module: 'server-applications' });

// Canonical public origin used for the email CTA. Mirrors `routes/seo.ts` so
// an accept email's "Open server" link matches what a guest would see at
// /s/:vanity.
const PUBLIC_ORIGIN =
  process.env.PUBLIC_APP_ORIGIN ||
  process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() ||
  'http://localhost:3000';

const router = Router({ mergeParams: true });

// Optional auth
//
// GET /questions allows anonymous reads when the server is publicly
// discoverable, but should still attribute the request to a user when an
// `Authorization: Bearer <token>` header is present. This middleware is
// permissive: a missing or malformed token simply leaves req.userId undefined
// rather than rejecting the request. Session-revocation/suspended checks are
// skipped here because anonymous reads are allowed; the worst-case for a
// revoked-but-not-yet-expired token is that the read is treated as anonymous,
// which is strictly less privileged.
function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId?: string; purpose?: string };
    if (decoded?.userId && !decoded.purpose) {
      req.userId = decoded.userId;
    }
  } catch { /* swallow — treat as anonymous */ }
  next();
}

// Rate limiters
//
// The "submit" limiter is the only sensitive one — it gates application
// creation at 3/day per authenticated user (spec). Reads and reviewer
// actions share a generic limiter.
const applicationSubmitLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:server-app-submit:'),
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: { error: 'You can only submit 3 applications per day. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  standardHeaders: true,
  legacyHeaders: false,
});

const applicationReadLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:server-app-read:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  standardHeaders: true,
  legacyHeaders: false,
});

const applicationMutationLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:server-app-mut:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  standardHeaders: true,
  legacyHeaders: false,
});

// Types

type ApplicationQuestion = {
  id: string;
  prompt: string;
  type: 'short_text' | 'long_text' | 'multiple_choice';
  required: boolean;
  maxLength: number;
  choices?: string[];
};

// Stored shape going forward; `value` is the canonical field name and
// matches the frontend `ApplicationAnswer` type. Older rows (if any) may
// have been stored as `{ questionId, answer }` — `normaliseStoredAnswers`
// below flattens both shapes when serialising for response.
type StoredAnswer = { questionId: string; value: string };

type SubmittedAnswerInput = { questionId: string; value?: string; answer?: string };

function normaliseStoredAnswers(raw: unknown): StoredAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredAnswer[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const qid = (a as { questionId?: unknown }).questionId;
    if (typeof qid !== 'string') continue;
    const value = (a as { value?: unknown }).value;
    const legacy = (a as { answer?: unknown }).answer;
    const text = typeof value === 'string' ? value : typeof legacy === 'string' ? legacy : '';
    out.push({ questionId: qid, value: text });
  }
  return out;
}

function parseQuestions(raw: unknown): ApplicationQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is ApplicationQuestion =>
    !!q && typeof q === 'object'
    && typeof (q as { id?: unknown }).id === 'string'
    && typeof (q as { prompt?: unknown }).prompt === 'string'
    && typeof (q as { type?: unknown }).type === 'string'
  );
}

// GET /questions — read application questions
//
// Logged-in users can always read; anonymous reads are allowed only when the
// server is community-discoverable (public preview surface). The list is
// considered public metadata about the server's join flow.
router.get(
  '/questions',
  validateUuidParams('serverId'),
  applicationReadLimiter,
  optionalAuth,
  validate(getApplicationQuestionsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');

    // Authenticated callers always pass; anonymous callers must clear
    // `isPubliclyDiscoverable`. Failures collapse to 404 to avoid leaking
    // server existence (suspended / hidden / mature → 404, not 401/403).
    const [settings, server] = await Promise.all([
      prisma.serverSettings.findUnique({
        where: { serverId },
        select: {
          applicationQuestions: true,
          joinMethod: true,
          communityEnabled: true,
          discoveryEnabled: true,
        },
      }),
      prisma.server.findUnique({
        where: { id: serverId },
        select: {
          id: true,
          suspendedAt: true,
          hiddenFromDiscovery: true,
        },
      }),
    ]);
    if (!settings || !server) return res.status(404).json({ error: 'not_found' });

    if (!req.userId && !isPubliclyDiscoverable(server, settings)) {
      // Anonymous + non-discoverable → 404 (never 401/403; leaks existence).
      return res.status(404).json({ error: 'not_found' });
    }

    const questions = parseQuestions(settings.applicationQuestions);
    res.json({ joinMethod: settings.joinMethod, questions });
  })
);

// PATCH /questions — owner/manage-server configures questions
router.patch(
  '/questions',
  authenticateToken,
  validateUuidParams('serverId'),
  applicationMutationLimiter,
  validate(updateApplicationQuestionsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(ctx, 'manageServer')) {
      return res.status(403).json({ error: 'You need the Manage Server permission' });
    }

    const { questions } = req.body as { questions: ApplicationQuestion[] };

    // Defensive structural checks — Zod has already enforced limits, but the
    // multiple_choice/choices coupling is a cross-field invariant we need to
    // re-check here.
    for (const q of questions) {
      if (q.type === 'multiple_choice') {
        if (!q.choices || q.choices.length < 2) {
          return res.status(400).json({ error: `Question "${q.id}" must have at least 2 choices` });
        }
      }
    }
    // Question IDs must be unique within the set.
    const ids = new Set<string>();
    for (const q of questions) {
      if (ids.has(q.id)) return res.status(400).json({ error: `Duplicate question id: ${q.id}` });
      ids.add(q.id);
    }

    const updated = await prisma.serverSettings.upsert({
      where: { serverId },
      create: { serverId, applicationQuestions: questions as never },
      update: { applicationQuestions: questions as never },
      select: { applicationQuestions: true },
    });

    await createAuditLog(serverId, req.userId, 'applications_questions_update', 'settings', serverId, {
      count: questions.length,
    });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${serverId}`).emit('server-applications-updated', { serverId, kind: 'questions' });

    res.json({ questions: parseQuestions(updated.applicationQuestions) });
  })
);

// POST / — applicant submits an application
router.post(
  '/',
  authenticateToken,
  validateUuidParams('serverId'),
  applicationSubmitLimiter,
  validate(submitApplicationSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');

    const { answers, captchaToken } = req.body as { answers: SubmittedAnswerInput[]; captchaToken?: string };

    // Captcha gate — same pattern as auth/register. In dev/test the service
    // returns true when no secret is configured.
    const captchaOk = await verifyCaptcha(captchaToken, req.ip);
    if (!captchaOk) {
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }

    // Single round-trip for the four pre-flight checks: ban / server existence
    // / settings / existing-membership. All four are independent reads.
    const [ban, server, settings, existingMember] = await Promise.all([
      prisma.serverBan.findUnique({ where: { serverId_userId: { serverId, userId: req.userId } }, select: { id: true } }),
      prisma.server.findUnique({ where: { id: serverId }, select: { id: true, name: true } }),
      prisma.serverSettings.findUnique({
        where: { serverId },
        select: { joinMethod: true, applicationQuestions: true },
      }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        select: { userId: true },
      }),
    ]);
    if (ban) return res.status(403).json({ error: 'You are banned from this server.' });
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (existingMember) {
      return res.status(400).json({ error: 'You are already a member of this server.' });
    }

    // Spec: if joinMethod is not apply_to_join, treat as a misconfigured
    // call — the user could likely join via invite directly.
    if (!settings || settings.joinMethod !== 'apply_to_join') {
      return res.status(400).json({ error: 'application_not_required' });
    }

    // Reject duplicate pending applications. The DB unique index is the
    // ultimate guard; this check produces a friendlier 409.
    const dup = await prisma.serverApplication.findFirst({
      where: { serverId, userId: req.userId, status: 'pending' },
      select: { id: true },
    });
    if (dup) return res.status(409).json({ error: 'You already have a pending application for this server.' });

    const questions = parseQuestions(settings.applicationQuestions);

    // Validate that the submitted answers cover required questions and that
    // every answer references a known question. Trim oversized answers per
    // each question's maxLength as a final defensive cap (Zod already
    // enforces 2000 char ceiling).
    const questionMap = new Map(questions.map(q => [q.id, q]));
    const sanitizedAnswers: StoredAnswer[] = [];
    for (const a of answers) {
      const q = questionMap.get(a.questionId);
      if (!q) continue; // ignore unknown question ids silently
      const text = typeof a.value === 'string' ? a.value : typeof a.answer === 'string' ? a.answer : '';
      const trimmed = text.slice(0, q.maxLength);
      sanitizedAnswers.push({ questionId: a.questionId, value: trimmed });
    }
    const answeredIds = new Set(sanitizedAnswers.map(a => a.questionId));
    for (const q of questions) {
      if (q.required) {
        const a = sanitizedAnswers.find(x => x.questionId === q.id);
        if (!a || a.value.trim().length === 0) {
          return res.status(400).json({ error: `Question "${q.prompt}" is required.` });
        }
      }
    }
    // For multiple-choice required questions, the answer must be one of the
    // configured choices.
    for (const q of questions) {
      if (q.type === 'multiple_choice' && answeredIds.has(q.id)) {
        const a = sanitizedAnswers.find(x => x.questionId === q.id);
        if (a && q.choices && !q.choices.includes(a.value)) {
          return res.status(400).json({ error: `Invalid choice for "${q.prompt}".` });
        }
      }
    }

    let created;
    try {
      created = await prisma.serverApplication.create({
        data: {
          serverId,
          userId: req.userId,
          answers: sanitizedAnswers as never,
          status: 'pending',
        },
      });
    } catch (err) {
      // Race-condition fallback for the unique-index violation.
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        return res.status(409).json({ error: 'You already have a pending application for this server.' });
      }
      throw err;
    }

    await createAuditLog(serverId, req.userId, 'application_submit', 'application', created.id);

    log.info({ serverId, userId: req.userId, applicationId: created.id }, 'Application submitted');

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${serverId}`).emit('server-applications-updated', { serverId, kind: 'list' });

    res.status(201).json({
      id: created.id,
      status: created.status,
      createdAt: created.createdAt.toISOString(),
    });
  })
);

// DELETE /me — applicant withdraws their pending application
router.delete(
  '/me',
  authenticateToken,
  validateUuidParams('serverId'),
  applicationMutationLimiter,
  validate(withdrawApplicationSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');

    const app = await prisma.serverApplication.findFirst({
      where: { serverId, userId: req.userId, status: 'pending' },
      select: { id: true },
    });
    if (!app) return res.status(404).json({ error: 'No pending application found.' });

    // Move pending → withdrawn. The unique index `(serverId, userId, status)`
    // permits this transition because the new status is distinct from any
    // existing decided rows for the same user.
    const updated = await prisma.serverApplication.update({
      where: { id: app.id },
      data: { status: 'withdrawn', decidedAt: new Date() },
    });

    await createAuditLog(serverId, req.userId, 'application_withdraw', 'application', app.id);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${serverId}`).emit('server-applications-updated', { serverId, kind: 'list' });

    res.json({ id: updated.id, status: updated.status });
  })
);

// GET / — owner/reviewer lists applications
router.get(
  '/',
  authenticateToken,
  validateUuidParams('serverId'),
  applicationReadLimiter,
  validate(listApplicationsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    // The codebase doesn't ship a Discord-style "manageMembers" permission;
    // kickMembers is the canonical "moderate the member roster" gate, so
    // reviewers must have either kickMembers or manageServer (owner-equiv).
    if (!hasPermission(ctx, 'kickMembers') && !hasPermission(ctx, 'manageServer')) {
      return res.status(403).json({ error: 'You need the Kick Members permission to review applications.' });
    }

    const status = (req.query.status as string | undefined) ?? undefined;
    const cursor = (req.query.cursor as string | undefined) ?? undefined;
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '50', 10) || 50));

    const where: Record<string, unknown> = { serverId };
    if (status) where.status = status;
    if (cursor) where.createdAt = { lt: new Date(cursor) };

    const apps = await prisma.serverApplication.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, username: true, discriminator: true, avatar: true, createdAt: true } },
        reviewer: { select: { id: true, username: true, discriminator: true, avatar: true } },
      },
    });

    const nextCursor = apps.length === limit ? apps[apps.length - 1].createdAt.toISOString() : null;

    res.json({
      applications: apps.map(a => ({
        id: a.id,
        serverId,
        applicant: a.user
          ? {
              id: a.user.id,
              username: a.user.username,
              discriminator: a.user.discriminator,
              avatar: a.user.avatar ?? null,
            }
          : null,
        answers: normaliseStoredAnswers(a.answers),
        status: a.status,
        reviewer: a.reviewer
          ? {
              id: a.reviewer.id,
              username: a.reviewer.username,
              discriminator: a.reviewer.discriminator,
              avatar: a.reviewer.avatar ?? null,
            }
          : null,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        decisionNote: a.decisionNote,
        internalNote: a.internalNote,
        createdAt: a.createdAt.toISOString(),
      })),
      nextCursor,
    });
  })
);

// PATCH /:appId — accept or reject
router.patch(
  '/:appId',
  authenticateToken,
  validateUuidParams('serverId', 'appId'),
  applicationMutationLimiter,
  validate(decideApplicationSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const appId = getParam(req, 'appId');
    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(ctx, 'kickMembers') && !hasPermission(ctx, 'manageServer')) {
      return res.status(403).json({ error: 'You need the Kick Members permission to review applications.' });
    }

    const { decision, note, internalNote } = req.body as {
      decision: 'accept' | 'reject';
      note?: string;
      internalNote?: string;
    };

    // Batch the three independent reads: application row (incl. applicant
    // identity for the lifecycle email), server name + vanity (notification
    // body + email CTA URL), and the default Member role (only used on
    // accept, but cheap to always fetch and avoids a sequential round-trip in
    // the accept branch).
    const [app, server, memberRole] = await Promise.all([
      prisma.serverApplication.findFirst({
        where: { id: appId, serverId },
        include: {
          user: { select: { id: true, username: true, email: true } },
        },
      }),
      prisma.server.findUnique({
        where: { id: serverId },
        select: { name: true, vanityUrl: true },
      }),
      prisma.serverRole.findFirst({
        where: { serverId, name: 'Member', isEveryone: false },
        select: { id: true },
      }),
    ]);
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.status !== 'pending') {
      return res.status(409).json({ error: `Application already ${app.status}` });
    }

    const newStatus = decision === 'accept' ? 'accepted' : 'rejected';
    const decisionUpdate = {
      status: newStatus,
      reviewerId: req.userId,
      decidedAt: new Date(),
      decisionNote: note ?? null,
      internalNote: internalNote ?? null,
    };

    // Single handler-scoped Socket.IO server, reused by the welcome post (accept
    // branch) and the notification/list emits below (both accept + decline).
    const io = req.app.get('io') as import('socket.io').Server | undefined;

    // Apply the server's verification-level gates before the moderator's
    // accept can flip the applicant into a member. Mirrors the gates that
    // `routes/invites.ts` runs on the invite-acceptance path so the owner's
    // policy isn't bypassable by routing the same user through apply-to-join.
    // There is no server-level age gate — per-channel age-restriction is the
    // only NSFW concept now.
    if (decision === 'accept') {
      const settings = await prisma.serverSettings.findUnique({
        where: { serverId },
        select: { verificationLevel: true },
      });

      const level = settings?.verificationLevel ?? 'none';
      if (level !== 'none') {
        const applicant = await prisma.user.findUnique({
          where: { id: app.userId },
          select: { emailVerified: true, createdAt: true },
        });
        if (level === 'low' || level === 'medium' || level === 'high') {
          if (!applicant?.emailVerified) {
            return res.status(409).json({
              error: 'verification_level_blocks_join',
              detail: 'Applicant must verify their email before being accepted at this verification level.',
            });
          }
        }
        if (level === 'medium' || level === 'high') {
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
          if (applicant && applicant.createdAt > fiveMinAgo) {
            return res.status(409).json({
              error: 'verification_level_blocks_join',
              detail: 'Applicant\'s account must be at least 5 minutes old to be accepted at this verification level.',
            });
          }
        }
        if (level === 'high') {
          const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
          if (applicant && applicant.createdAt > tenMinAgo) {
            return res.status(409).json({
              error: 'verification_level_blocks_join',
              detail: 'Applicant\'s account must be at least 10 minutes old to be accepted at this verification level.',
            });
          }
        }
      }
    }

    // For accept: idempotently make the applicant a ServerMember. We do the
    // status update + member creation in a single transaction so a failure
    // can't leave the application "accepted" with no member row, or vice
    // versa.
    if (decision === 'accept') {
      await prisma.$transaction([
        prisma.serverMember.upsert({
          where: { userId_serverId: { userId: app.userId, serverId } },
          create: {
            userId: app.userId,
            serverId,
            role: 'member',
            roleId: memberRole?.id ?? undefined,
          },
          update: {},
        }),
        prisma.serverApplication.update({ where: { id: appId }, data: decisionUpdate }),
      ]);

      // Materialise MemberRole join for the multi-role permissions system —
      // mirrors the invite-join code path.
      if (memberRole) {
        await prisma.memberRole.upsert({
          where: { userId_serverId_roleId: { userId: app.userId, serverId, roleId: memberRole.id } },
          create: { userId: app.userId, serverId, roleId: memberRole.id },
          update: {},
        });
      }
      await invalidatePermissionContext(serverId, app.userId);

      // Grant any configured auto-assign roles + recompute the member's display
      // role, mirroring the invite-join path.
      await applyAutoAssignRoles(serverId, app.userId);

      // Post the configured welcome system message so apply-to-join joiners get
      // the same announcement as invite joiners (shared helper resolves the
      // welcome channel + settings and never throws).
      const applicantUser = await prisma.user.findUnique({
        where: { id: app.userId },
        select: { username: true },
      });
      await postJoinWelcomeMessage(serverId, { id: app.userId, username: applicantUser?.username ?? 'someone' }, io);
    } else {
      await prisma.serverApplication.update({ where: { id: appId }, data: decisionUpdate });
    }

    const notifTitle = decision === 'accept' ? 'Application accepted' : 'Application declined';
    const notifBody = decision === 'accept'
      ? `Welcome to ${server?.name ?? 'the server'}!`
      : `Your application to ${server?.name ?? 'a server'} was declined.`;
    await prisma.notification.create({
      data: {
        userId: app.userId,
        serverId,
        type: 'application_decision',
        title: notifTitle,
        body: notifBody,
        metadata: { applicationId: appId, decision: newStatus },
      },
    }).catch((err) => {
      log.warn({ err, applicationId: appId }, 'Failed to create application notification');
    });

    // Realtime push so a logged-in applicant sees it immediately.
    if (io) {
      io.to(`user:${app.userId}`).emit('notification-created', {
        serverId,
        type: 'application_decision',
        title: notifTitle,
        body: notifBody,
        metadata: { applicationId: appId, decision: newStatus },
        createdAt: new Date().toISOString(),
      });
    }

    await createAuditLog(serverId, req.userId, 'application_decided', 'application', appId, {
      decision: newStatus,
      applicantId: app.userId,
      note: note ?? undefined,
    });

    if (io) io.to(`server:${serverId}`).emit('server-applications-updated', { serverId, kind: 'list' });

    // Lifecycle email — fire-and-forget. We never block the API response on
    // SMTP latency, and a delivery failure must NOT roll back the decision
    // (the in-app notification + DB row already record the outcome). Email
    // addresses are stored encrypted at rest; decrypt only at send time and
    // never log the plaintext.
    if (app.user) {
      let plaintextEmail: string | null = null;
      try {
        plaintextEmail = decryptSecret(app.user.email);
      } catch (err) {
        log.warn({ err, applicationId: appId }, 'application_decision_email_decrypt_failed');
      }
      if (plaintextEmail) {
        const serverName = server?.name ?? 'a Howl community';
        const applicantName = app.user.username;
        if (decision === 'accept') {
          const slug = server?.vanityUrl ?? serverId;
          const serverUrl = `${PUBLIC_ORIGIN}/s/${slug}`;
          sendApplicationAcceptedEmail(plaintextEmail, { applicantName, serverName, serverUrl, note: note ?? undefined })
            .catch((err) => log.warn({ err, applicationId: appId }, 'application_accepted_email_send_failed'));
        } else {
          sendApplicationRejectedEmail(plaintextEmail, { applicantName, serverName, note: note ?? undefined })
            .catch((err) => log.warn({ err, applicationId: appId }, 'application_rejected_email_send_failed'));
        }
      }
    }

    log.info({ serverId, applicationId: appId, decision: newStatus, reviewerId: req.userId }, 'Application decided');

    res.json({
      id: appId,
      status: newStatus,
      decidedAt: new Date().toISOString(),
      decisionNote: note ?? null,
    });
  })
);

export default router;
