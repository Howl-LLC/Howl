// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * GDPR compliance routes — data export and enhanced account deletion.
 *
 * POST /api/gdpr/export           — instant download all user data as JSON (legacy)
 * POST /api/gdpr/request-export   — request an async data export (queued)
 * GET  /api/gdpr/export-status    — check status of most recent export request
 * GET  /api/gdpr/download/:id     — download a completed export via token
 * POST /api/gdpr/delete           — permanently delete account and purge all data
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { EXPORTS_DIR } from '../exportsDir.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { gdprDeleteSchema, gdprDeactivateSchema, gdprExportSchema } from '../schemas.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { buildExportData } from '../services/exportBuilder.js';
import {
  findUserVoiceChannel, findUserDmCall, removeVoiceParticipant,
  setVoiceReverseLookup, deleteVoiceOverride, setDmCallReverseLookup,
  removeDmCallParticipant, getVoiceParticipants,
  invalidatePermissionContext,
} from '../redis.js';
import { removeLiveKitParticipant } from '../services/livekitAdmin.js';
import { scheduleVoiceE2eeRotate } from '../services/voiceE2eeRotation.js';
import crypto from 'crypto';

let _stripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    _stripe = new Stripe(key);
  }
  return _stripe;
}
import bcrypt from 'bcrypt';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { enqueueDataExport } from '../queues/producers.js';
import fs from 'fs';
import path from 'path';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { broadcastPresenceChange } from '../socketHandlers/infrastructure.js';
import { emitUserSecurityEvent } from '../services/securityEvents.js';

const log = logger.child({ module: 'gdpr' });
const router = Router();

const gdprLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:gdpr:'),
  windowMs: 60 * 60 * 1000,
  max: 1,
  message: { error: 'Too many requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const gdprDownloadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:gdpr-dl:'),
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many download attempts. Try again later.' },
});

const exportRequestLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:export:'),
  windowMs: 60 * 60 * 1000,
  max: 2,
  message: { error: 'Too many export requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

import { getS3Client, S3_BUCKET, S3_PREFIX, s3Enabled } from '../services/s3.js';
import { getClientIp } from '../utils/clientIp.js';
const s3 = getS3Client();

function extractFilename(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.split('/').pop() ?? null;
}

async function deleteS3File(filename: string): Promise<void> {
  if (!s3Enabled || !s3 || !filename) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}${filename}` }));
  } catch {
    // best-effort; file may already be gone
  }
}

// POST /api/gdpr/export — assemble all user data into a JSON download
router.post('/export', authenticateToken, gdprLimiter, validate(gdprExportSchema), async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;

  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.passwordHash) {
      if (!password) return res.status(400).json({ error: 'Password is required to export your data' });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Password is incorrect' });
    } else {
      if (!req.body?.confirmSsoExport) return res.status(400).json({ error: 'Please confirm data export', requiresSsoConfirmation: true });
    }

    const exportData = await buildExportData(req.userId);

    res.setHeader('Content-Type', 'application/json');
    // Sanitize username for Content-Disposition to prevent header injection
    const safeUsername = user.username.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    res.setHeader('Content-Disposition', `attachment; filename="howl-data-export-${safeUsername}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(exportData);
    log.info({ userId: req.userId }, 'data export completed');
  } catch (err) {
    log.error({ err, userId: req.userId }, 'data export failed');
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// POST /api/gdpr/request-export — submit an async data export request
router.post('/request-export', authenticateToken, exportRequestLimiter, validate(gdprExportSchema), async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;

  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.passwordHash) {
      if (!password) return res.status(400).json({ error: 'Password is required to request a data export' });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Password is incorrect' });
    } else {
      if (!req.body?.confirmSsoExport) return res.status(400).json({ error: 'Please confirm data export', requiresSsoConfirmation: true });
    }

    const existing = await prisma.dataExportRequest.findFirst({
      where: { userId: req.userId, status: { in: ['pending', 'processing'] } },
    });
    if (existing) {
      return res.status(409).json({ error: 'You already have an export in progress', requestId: existing.id, status: existing.status });
    }

    const COOLDOWN_DAYS = 7;
    const lastCompleted = await prisma.dataExportRequest.findFirst({
      where: { userId: req.userId, status: { in: ['ready', 'expired'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (lastCompleted) {
      const cooldownEnd = new Date(lastCompleted.createdAt.getTime() + COOLDOWN_DAYS * 86_400_000);
      if (Date.now() < cooldownEnd.getTime()) {
        return res.status(429).json({
          error: `You can request another export after ${cooldownEnd.toISOString()}`,
          nextAvailableAt: cooldownEnd.toISOString(),
        });
      }
    }

    const request = await prisma.dataExportRequest.create({
      data: { userId: req.userId },
    });

    await enqueueDataExport({ requestId: request.id, userId: req.userId });

    log.info({ userId: req.userId, requestId: request.id }, 'data export requested');
    res.json({ requestId: request.id, message: 'Your data export has been requested. You will receive an email when it is ready.' });
  } catch (err) {
    log.error({ err, userId: req.userId }, 'data export request failed');
    res.status(500).json({ error: 'Failed to request data export' });
  }
});

// GET /api/gdpr/export-status — check status of most recent export request
router.get('/export-status', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const request = await prisma.dataExportRequest.findFirst({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true, expiresAt: true, error: true },
    });

    if (!request) {
      return res.json({ hasRequest: false });
    }

    const isExpired = request.status === 'ready' && request.expiresAt && new Date() > request.expiresAt;
    if (isExpired) {
      await prisma.dataExportRequest.update({ where: { id: request.id }, data: { status: 'expired' } });
    }

    const COOLDOWN_DAYS = 7;
    const lastCompleted = await prisma.dataExportRequest.findFirst({
      where: { userId: req.userId, status: { in: ['ready', 'expired'] } },
      orderBy: { createdAt: 'desc' },
    });
    let nextAvailableAt: string | null = null;
    if (lastCompleted) {
      const cooldownEnd = new Date(lastCompleted.createdAt.getTime() + COOLDOWN_DAYS * 86_400_000);
      if (Date.now() < cooldownEnd.getTime()) {
        nextAvailableAt = cooldownEnd.toISOString();
      }
    }

    if (isExpired) {
      return res.json({
        hasRequest: true,
        requestId: request.id,
        status: 'expired',
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        nextAvailableAt,
      });
    }

    res.json({
      hasRequest: true,
      requestId: request.id,
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      ...(request.status === 'failed' ? { error: request.error } : {}),
      ...(request.status === 'ready' ? { downloadReady: true } : {}),
      nextAvailableAt,
    });
  } catch (err) {
    log.error({ err, userId: req.userId }, 'export status check failed');
    res.status(500).json({ error: 'Failed to check export status' });
  }
});

// GET /api/gdpr/download/:requestId — download a completed export via token
// Security: This endpoint uses a cryptographic download token (SHA-256 hashed in DB,
// compared via crypto.timingSafeEqual on buffers) instead of session-based auth so that
// email-based download links work without requiring the user to be logged in. The token
// is single-use (invalidated after download) and the export has an expiration window.
router.get('/download/:requestId', validateUuidParams('requestId'), gdprDownloadLimiter, async (req, res) => {
  const requestIdParam = req.params.requestId;
  const requestId = requestIdParam as string;
  const tokenRaw = req.query.token;
  const token = Array.isArray(tokenRaw) ? tokenRaw[0] : (typeof tokenRaw === 'string' ? tokenRaw : undefined);

  if (!requestId || !token) return res.status(400).json({ error: 'Request ID and download token are required' });

  try {
    const request = await prisma.dataExportRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { username: true } } },
    });

    if (!request) return res.status(404).json({ error: 'Export request not found' });
    if (!request.downloadToken) return res.status(403).json({ error: 'Download token already used' });
    // DB stores SHA-256 hex hash of token; compare using timingSafeEqual on buffers
    const incomingHash = crypto.createHash('sha256').update(typeof token === 'string' ? token : '').digest('hex');
    if (!request.downloadToken || request.downloadToken.length !== 64) {
      return res.status(403).json({ error: 'Invalid download token' });
    }
    const incomingBuf = Buffer.from(incomingHash, 'hex');
    const storedBuf = Buffer.from(request.downloadToken, 'hex');
    if (incomingBuf.length !== storedBuf.length || !crypto.timingSafeEqual(incomingBuf, storedBuf)) {
      return res.status(403).json({ error: 'Invalid download token' });
    }
    if (request.status !== 'ready') return res.status(400).json({ error: `Export is not ready (status: ${request.status})` });

    if (request.expiresAt && new Date() > request.expiresAt) {
      await prisma.dataExportRequest.update({ where: { id: requestId }, data: { status: 'expired' } });
      return res.status(410).json({ error: 'This download link has expired' });
    }

    // Path traversal protection against a tampered stored filePath.
    const exportsBaseDir = EXPORTS_DIR;
    if (request.filePath) {
      const safePath = path.resolve(request.filePath);
      if (!safePath.startsWith(path.resolve(exportsBaseDir) + path.sep) && safePath !== path.resolve(exportsBaseDir)) {
        return res.status(403).json({ error: 'Invalid file path' });
      }
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!request.filePath || !fs.existsSync(request.filePath)) {
      return res.status(404).json({ error: 'Export file not found' });
    }

    // Atomically claim the download token before streaming (single-use enforcement)
    const claimed = await prisma.dataExportRequest.updateMany({
      where: { id: requestId!, downloadToken: request.downloadToken },
      data: { downloadToken: '' },
    });
    if (claimed.count === 0) {
      return res.status(403).json({ error: 'Download token already used' });
    }

    // Sanitize username for Content-Disposition to prevent header injection
    const rawUsername = request.user?.username || 'user';
    const username = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const dateStr = request.createdAt.toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="howl-data-export-${username}-${dateStr}.json"`);

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const readStream = fs.createReadStream(request.filePath);
    const exportFilePath = request.filePath;
    readStream.on('end', () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path validated against exportsBaseDir above
      fs.unlink(exportFilePath, () => {});
      prisma.dataExportRequest.update({
        where: { id: requestId! },
        data: { filePath: '' },
      }).catch(() => {});
    });
    readStream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream export file' });
    });
    readStream.pipe(res);

    log.info({ requestId }, 'data export downloaded');
  } catch (err) {
    log.error({ err, requestId }, 'data export download failed');
    res.status(500).json({ error: 'Failed to download export' });
  }
});

// POST /api/gdpr/deactivate — soft-disable account (reversible by logging in)
router.post('/deactivate', authenticateToken, gdprLimiter, validate(gdprDeactivateSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const { password, confirmSsoDeactivate } = req.body as { password?: string; confirmSsoDeactivate?: boolean };

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Require password for password users, confirmation for SSO users
  if (user.passwordHash) {
    if (!password) return res.status(400).json({ error: 'Password is required' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Password is incorrect' });
  } else {
    if (!confirmSsoDeactivate) return res.status(400).json({ error: 'Please confirm deactivation', requiresSsoConfirmation: true });
  }

  // Set deactivated, go offline
  await prisma.user.update({
    where: { id: req.userId },
    data: { deactivated: true, deactivatedAt: new Date(), status: 'offline' },
  });

  // Invalidate all sessions
  await prisma.session.deleteMany({ where: { userId: req.userId } });

  // Broadcast offline presence to friends/servers and force-disconnect sockets
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    await broadcastPresenceChange(req.userId!, 'offline').catch(() => {});
    const userSockets = await io.in(`user:${req.userId}`).fetchSockets();
    for (const s of userSockets) {
      s.emit('account-deactivated', { message: 'Your account has been deactivated.' });
      s.disconnect(true);
    }
  }

  log.info({ userId: req.userId }, 'account deactivated');
  res.json({ success: true });
}));

// POST /api/gdpr/delete — full account deletion with data purge
router.post('/delete', authenticateToken, gdprLimiter, validate(gdprDeleteSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const { password, confirmSsoDelete } = req.body as { password?: string; confirmSsoDelete?: boolean };

  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.passwordHash) {
      if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Password is incorrect' });
    } else {
      if (!confirmSsoDelete) return res.status(400).json({ error: 'Please confirm account deletion', requiresSsoConfirmation: true });
    }

    // Emit BEFORE the user row is deleted. The UserSecurityEvent
    // row itself cascade-deletes with the user (per schema.prisma), so the
    // primary durable trace of the self-delete is the structured `log.info`
    // line inside the helper, not the UserSecurityEvent row. Awaited so the
    // write hits the DB before the delete transaction below; the helper
    // itself is fail-safe (log.warn on error, never throws).
    await emitUserSecurityEvent(req.userId, 'self_delete_initiated', req);

    // io is needed both here (forward-secrecy rotate on the active voice
    // channel) and later (force-disconnect sockets / broadcast offline).
    const io = req.app.get('io') as import('socket.io').Server | undefined;

    // 0. Drop any active LiveKit SFU sessions for this user.
    // Must run before the DB + socket teardown so a user who is mid-call when
    // they trigger deletion can't continue publishing audio after the account
    // is gone.
    try {
      const [voiceChannelId, dmChannelId] = await Promise.all([
        findUserVoiceChannel(req.userId),
        findUserDmCall(req.userId),
      ]);
      if (voiceChannelId) {
        await removeVoiceParticipant(voiceChannelId, req.userId);
        await setVoiceReverseLookup(req.userId, null);
        await deleteVoiceOverride(voiceChannelId, req.userId);
        removeLiveKitParticipant(`voice:${voiceChannelId}`, req.userId).catch(() => {});
        // Forward secrecy: notify remaining members (so their leader
        // backstop prunes this departed user) and rotate the SFrame key so the
        // deleted account's retained key no longer protects subsequent media.
        if (io) {
          io.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId: req.userId });
          const remaining = await getVoiceParticipants(voiceChannelId);
          scheduleVoiceE2eeRotate(io, voiceChannelId, remaining.length > 0);
        }
      }
      if (dmChannelId) {
        await removeDmCallParticipant(dmChannelId, req.userId);
        await setDmCallReverseLookup(req.userId, null);
        removeLiveKitParticipant(`dm-call:${dmChannelId}`, req.userId).catch(() => {});
      }
    } catch (e) {
      log.warn({ err: e, userId: req.userId }, 'voice/dm-call cleanup failed during account deletion');
    }

    // 0a. Cancel Stripe subscriptions if active
    if (user.stripeSubscriptionId) {
      const stripe = getStripe();
      if (stripe) {
        try {
          await stripe.subscriptions.cancel(user.stripeSubscriptionId);
        } catch (e) { log.warn({ err: e }, 'failed to cancel Stripe subscription during account deletion'); }
      }
    }
    if (user.powerUpSubscriptionId) {
      const stripe = getStripe();
      if (stripe) {
        try {
          await stripe.subscriptions.cancel(user.powerUpSubscriptionId);
        } catch (e) { log.warn({ err: e }, 'failed to cancel power-up subscription during account deletion'); }
      }
    }
    if (user.stripeCustomerId) {
      const stripe = getStripe();
      if (stripe) {
        try {
          await stripe.customers.del(user.stripeCustomerId);
        } catch (e) { log.warn({ err: e }, 'failed to delete Stripe customer during account deletion'); }
      }
    }

    // 0b. Check for owned servers — transfer or block deletion (wrapped in transaction to prevent races)
    const ownedServers = await prisma.serverMember.findMany({
      where: { userId: req.userId, role: 'owner' },
      select: { serverId: true },
      take: 200,
    });
    for (const owned of ownedServers) {
      const transferredTo = await prisma.$transaction(async (tx) => {
        const nextOwner = await tx.serverMember.findFirst({
          where: { serverId: owned.serverId, userId: { not: req.userId } },
          orderBy: { joinedAt: 'asc' },
          select: { userId: true },
        });
        if (nextOwner) {
          const ownerRole = await tx.serverRole.findFirst({
            where: { serverId: owned.serverId, name: { equals: 'Owner', mode: 'insensitive' } },
            select: { id: true },
          });
          await tx.serverMember.update({
            where: { userId_serverId: { userId: nextOwner.userId, serverId: owned.serverId } },
            data: { role: 'owner', ...(ownerRole ? { roleId: ownerRole.id } : {}) },
          });
          return nextOwner.userId;
        }
        await tx.server.delete({ where: { id: owned.serverId } });
        return null;
      });
      if (transferredTo) {
        await invalidatePermissionContext(owned.serverId, transferredTo);
      }
    }

    // Snapshot all server memberships before user.delete cascades them away
    // so we can drop every cached permission context this user had. TTL would
    // eventually evict them, but explicit invalidation prevents peer replicas
    // from serving ghost rows.
    const memberships = await prisma.serverMember.findMany({
      where: { userId: req.userId },
      select: { serverId: true },
      take: 1000,
    });

    // 1. Collect all attachment URLs the user uploaded (for S3/disk cleanup) — paginated
    async function collectAttachmentFilenames(
      model: 'message' | 'dMMessage',
      authorId: string,
    ): Promise<string[]> {
      const filenames: string[] = [];
      let cursor: string | undefined;
      const prismaModel = model === 'message' ? prisma.message : prisma.dMMessage;
      while (true) {
        const batch = await (prismaModel as any).findMany({
          where: { authorId, attachmentUrl: { not: null } },
          select: { id: true, attachmentUrl: true },
          take: 1000,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
        });
        for (const m of batch) {
          const f = extractFilename(m.attachmentUrl);
          if (f) filenames.push(f);
        }
        if (batch.length < 1000) break;
        cursor = batch[batch.length - 1].id;
      }
      return filenames;
    }
    const [msgFiles, dmFiles] = await Promise.all([
      collectAttachmentFilenames('message', req.userId!),
      collectAttachmentFilenames('dMMessage', req.userId!),
    ]);
    const filesToDelete = new Set([...msgFiles, ...dmFiles]);
    if (user.avatar) { const f = extractFilename(user.avatar); if (f) filesToDelete.add(f); }
    if (user.banner) { const f = extractFilename(user.banner); if (f) filesToDelete.add(f); }

    // 2. Clean up any pending data export files on disk before cascading deletion
    const exportRequests = await prisma.dataExportRequest.findMany({
      where: { userId: req.userId, filePath: { not: null } },
      select: { filePath: true },
      take: 100,
    });
    const exportsBaseDir = EXPORTS_DIR;
    for (const er of exportRequests) {
      if (er.filePath) {
        const safePath = path.resolve(er.filePath);
        if (safePath.startsWith(exportsBaseDir + path.sep)) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path validated by startsWith check above
          try { fs.unlinkSync(safePath); } catch { /* best effort */ }
        }
      }
    }

    // 3. Permission override cleanup (member overrides for this user — no user FK)
    await prisma.$transaction([
      prisma.channelPermissionOverride.deleteMany({ where: { targetType: 'member', targetId: req.userId } }),
      prisma.categoryPermissionOverride.deleteMany({ where: { targetType: 'member', targetId: req.userId } }),
    ]);

    // 3b. Delete rows keyed on bare user-id strings with no FK cascade.
    // FK cascade on author/uploader covers Message, DMMessage,
    // ThreadMessage, Thread, Poll, ForumPost, ForumMessage, CustomEmoji,
    // Sticker, SoundboardSound, MessageReport.authorId, those handlers are
    // now gone (the user.delete() below cascades them).
    // SetNull columns (AuditLog.actorId, ChannelPinnedMessage.pinnedById,
    // DMPinnedMessage.pinnedById, ServerEvent.createdById,
    // MessageReport.reporterId, GiftSubscription.recipientId) are also handled
    // by the FK; no manual op.
    //
    // What remains are: rows whose user reference is still a bare String with
    // no FK (AuditLog.targetId, Invite.createdById, ServerTemplate.createdById,
    // StageSession.startedById, ServerBan.bannedById, ServerMember.timedOutById,
    // ImageHash.uploaderId), plus rows scoped by userId without relation
    // pattern (EventRsvp, PollVote, ThreadMessageReaction, ForumMessageReaction).
    await prisma.$transaction([
      prisma.serverBan.deleteMany({ where: { OR: [{ userId: req.userId }, { bannedById: req.userId }] } }),
      prisma.auditLog.updateMany({ where: { targetId: req.userId }, data: { targetId: 'deleted' } }),
      prisma.invite.deleteMany({ where: { createdById: req.userId } }),
      prisma.serverTemplate.deleteMany({ where: { createdById: req.userId } }),
      prisma.eventRsvp.deleteMany({ where: { userId: req.userId } }),
      prisma.pollVote.deleteMany({ where: { userId: req.userId } }),
      prisma.threadMessageReaction.deleteMany({ where: { userId: req.userId } }),
      prisma.forumMessageReaction.deleteMany({ where: { userId: req.userId } }),
      prisma.stageSession.updateMany({ where: { startedById: req.userId }, data: { startedById: 'deleted' } }),
    ]);

    // 4. Force-disconnect all sockets and broadcast offline presence
    // Must happen before user.delete — broadcastPresenceChange needs the user's
    // friends, memberships, and blocks which are cascade-deleted with the user.
    // (io was resolved above for the forward-secrecy rotate.)
    if (io) {
      await broadcastPresenceChange(req.userId!, 'offline').catch(() => {});
      const userSockets = await io.in(`user:${req.userId}`).fetchSockets();
      for (const s of userSockets) {
        s.emit('account-deleted', { message: 'Your account has been deleted.' });
        s.disconnect(true);
      }
    }

    // 5. Delete remaining non-cascading records + delete the user.
    // Models that cascade (or SetNull) automatically on user.delete via the
    // user FKs:
    //   Session, SsoAccount, PasskeyCredential, FamilyLink, Block,
    //   FriendRequest, ServerPowerUp, ServerMember, DMParticipant,
    //   PushSubscription, DataExportRequest, PendingTrialSetup,
    //   TrialCardFingerprint, Refund, ConnectedApp, TrustedDevice,
    //   LoginVerification, UserActivity, UserSecondaryActivity,
    //   ActivityHistory, DmKeyBundle, GameAccount, ServerFolder,
    //   GifFavorite, UserSettings  — all pre-existing cascades.
    //   Also Message, DMMessage, ThreadMessage, Thread, Poll,
    //   ForumPost, ForumMessage, CustomEmoji, Sticker, SoundboardSound,
    //   MessageReport.authorId cascade, MessageReport.reporterId SetNull,
    //   AuditLog.actorId SetNull, ChannelPinnedMessage.pinnedById SetNull,
    //   DMPinnedMessage.pinnedById SetNull, ServerEvent.createdById SetNull,
    //   GiftSubscription.senderId cascade, GiftSubscription.recipientId
    //   SetNull.
    //   DmHistoryArchive.userId cascade — the cross-device
    //   DM history archive rows die with the user; also deleted explicitly
    //   below (belt-and-suspenders) so the rows are gone even if the FK
    //   cascade is ever weakened.
    // ImageHash has no user FK — must still be deleted explicitly.
    await prisma.$transaction([
      prisma.imageHash.deleteMany({ where: { uploaderId: req.userId } }),
      prisma.dmHistoryArchive.deleteMany({ where: { userId: req.userId } }),
      // Delete-for-everyone tombstones (also FK-cascade on user delete;
      // explicit for parity with the archive deleteMany above).
      prisma.dmHistoryArchiveTombstone.deleteMany({ where: { userId: req.userId } }),
      prisma.user.delete({ where: { id: req.userId } }),
    ]);
    await Promise.all(
      memberships.map((m) => invalidatePermissionContext(m.serverId, req.userId!)),
    );

    // 6. Clean up files (best-effort, after DB deletion) — batched for speed
    const fileArr = [...filesToDelete];
    for (let i = 0; i < fileArr.length; i += 10) {
      await Promise.all(fileArr.slice(i, i + 10).map(f => deleteS3File(f)));
    }

    log.info({ userId: req.userId, filesDeleted: filesToDelete.size }, 'account deleted (GDPR)');
    res.json({ success: true });
  } catch (err) {
    log.error({ err, userId: req.userId }, 'account deletion failed');
    res.status(500).json({ error: 'Failed to delete account' });
  }
}));

export default router;
