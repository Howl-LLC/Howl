// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminReportsQuery, adminFlaggedHashesQuery, adminImageHashesQuery } from '../schemas.js';
import { z } from 'zod';
import { getIO } from '../socketIO.js';
import { logAction, validateUuidParam, adminLimiter } from './adminHelpers.js';
import { publishFlaggedHashUpdate } from '../redis.js';
import { decryptOrPlain } from '../services/mfaCrypto.js';
import { enqueueCleanup } from '../queues/producers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'adminReports' });

const router = Router();

const adminReportUpdateSchema = z.object({
  body: z.object({
    status: z.enum(['pending', 'reviewed', 'actioned', 'dismissed']).optional(),
    actionTaken: z.enum(['none', 'warn', 'delete', 'ban', 'ncmec_report']).optional(),
    reviewNotes: z.string().max(5000).optional(),
    ncmecReportId: z.string().max(100).optional(),
  }).strict(),
});

const adminFlaggedHashBody = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hex string'),
  reason: z.enum(['csam', 'illegal', 'other']),
  source: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const adminFlaggedHashValidation = z.object({ body: adminFlaggedHashBody });

const adminFlagFromReportBody = z.object({
  reportId: z.string().uuid('reportId must be a valid UUID'),
  reason: z.string().max(100).optional(),
}).strict();

const adminFlagFromReportValidation = z.object({ body: adminFlagFromReportBody });

const VALID_REPORT_ACTIONS = ['none', 'warn', 'delete', 'ban', 'ncmec_report'] as const;

// Message Reports

router.get('/reports', adminLimiter, validate(adminReportsQuery), async (req, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = 50;

  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  const [reports, total] = await Promise.all([
    prisma.messageReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.messageReport.count({ where }),
  ]);

  // Both reporterId and authorId are nullable post-cascade-relax. Identity at
  // report time lives in *Snapshot fields when the underlying User is gone.
  const reporterIds = [...new Set(reports.map(r => r.reporterId).filter((id): id is string => id !== null))];
  const authorIds = [...new Set(reports.map(r => r.authorId).filter((id): id is string => id !== null))];
  const allUserIds = [...new Set([...reporterIds, ...authorIds])];
  const users = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, username: true, discriminator: true, avatar: true },
    take: 200,
  });
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  res.json({
    reports: reports.map(r => {
      const decrypted = {
        ...r,
        content: typeof r.content === 'string' ? decryptOrPlain(r.content) : r.content,
        details: typeof r.details === 'string' ? decryptOrPlain(r.details) : r.details,
      };
      return {
        ...decrypted,
        reporter: r.reporterId ? (userMap[r.reporterId] || null) : null,
        author: r.authorId ? (userMap[r.authorId] || null) : null,
      };
    }),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

router.get('/reports/:reportId', adminLimiter, async (req, res: Response) => {
  const reportId = validateUuidParam(req.params.reportId);
  if (!reportId) return res.status(400).json({ error: 'Invalid reportId format' });
  const report = await prisma.messageReport.findUnique({ where: { id: reportId } });
  if (!report) return res.status(404).json({ error: 'Report not found' });

  // Both reporterId and authorId are nullable. Skip lookups when null and
  // let the response carry the snapshot fields for any deleted-account case.
  const [reporter, author] = await Promise.all([
    report.reporterId
      ? prisma.user.findUnique({ where: { id: report.reporterId }, select: { id: true, username: true, discriminator: true, avatar: true } })
      : Promise.resolve(null),
    report.authorId
      ? prisma.user.findUnique({ where: { id: report.authorId }, select: { id: true, username: true, discriminator: true, avatar: true } })
      : Promise.resolve(null),
  ]);

  const decrypted = {
    ...report,
    content: typeof report.content === 'string' ? decryptOrPlain(report.content) : report.content,
    details: typeof report.details === 'string' ? decryptOrPlain(report.details) : report.details,
  };
  res.json({ ...decrypted, reporter, author });
});

/**
 * Action-time evidence snapshot for user-reported CSAM. Auto-flagged uploads
 * already populate uploaderIp/userAgent synchronously at the upload request
 * (evidenceSource='upload-block') — those are the gold-standard, "IP that
 * committed the offense" values. This function is the best-effort fallback
 * for the *user-reported* path: when T&S confirms a CSAM report, we snapshot
 * the IP/UA from the session that was active *around the message's
 * timestamp* — i.e. the IP the user was on when they sent the abusive
 * content, not the IP they happen to have today. Critical because most
 * recent and message-time can diverge by weeks for repeat offenders.
 *
 * Returns whether the snapshot succeeded; the caller writes one of three
 * `evidenceSource` values onto the report so admins reading it later know
 * exactly what kind of evidence they're looking at.
 */
async function snapshotActionTimeEvidence(report: {
  id: string;
  messageType: string;
  messageId: string;
  authorId: string | null;
  evidenceSource: string | null;
  createdAt: Date;
}): Promise<{ source: 'action-time-lookup' | 'action-time-unavailable'; ip: string | null; ua: string | null }> {
  // No author → nothing to look up. Treat as unavailable so the moderator
  // sees the warning rather than silently filing without IP/UA.
  if (!report.authorId) {
    return { source: 'action-time-unavailable', ip: null, ua: null };
  }
  // Find the original message to get its createdAt. messageType dispatches
  // between the two distinct message tables. If the message has since been
  // deleted, fall back to the report's createdAt as a less-precise anchor —
  // worse than the message timestamp but better than "most recent."
  let messageCreatedAt: Date = report.createdAt;
  try {
    if (report.messageType === 'channel') {
      const m = await prisma.message.findUnique({
        where: { id: report.messageId },
        select: { createdAt: true },
      });
      if (m) messageCreatedAt = m.createdAt;
    } else if (report.messageType === 'dm') {
      const dm = await prisma.dMMessage.findUnique({
        where: { id: report.messageId },
        select: { createdAt: true },
      });
      if (dm) messageCreatedAt = dm.createdAt;
    }
  } catch { /* fall through to report.createdAt */ }

  // Session that was active around the message timestamp: most-recent
  // session whose createdAt <= messageCreatedAt. This biases toward the
  // session the user was most likely on *when they sent the message*,
  // which is what the ISP can resolve via subpoena. "Most recent for the
  // author" was the wrong question — that's whatever they're on today.
  const session = await prisma.session.findFirst({
    where: {
      userId: report.authorId,
      createdAt: { lte: messageCreatedAt },
      rawIp: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    select: { rawIp: true, userAgent: true },
  });
  if (!session || !session.rawIp) {
    return { source: 'action-time-unavailable', ip: null, ua: null };
  }
  return { source: 'action-time-lookup', ip: session.rawIp, ua: session.userAgent ?? null };
}

router.patch('/reports/:reportId', adminLimiter, validate(adminReportUpdateSchema), async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const reportId = validateUuidParam(req.params.reportId);
  if (!reportId) return res.status(400).json({ error: 'Invalid reportId format' });

  const { status, actionTaken, reviewNotes, ncmecReportId } = req.body as { status?: string; actionTaken?: string; reviewNotes?: string; ncmecReportId?: string };

  const report = await prisma.messageReport.findUnique({ where: { id: reportId } });
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (status && ['pending', 'reviewed', 'actioned', 'dismissed'].includes(status)) {
    updateData.status = status;
    if (status !== 'pending') {
      updateData.reviewedAt = new Date();
      updateData.reviewedBy = authReq.adminId;
    }
  }
  if (actionTaken && VALID_REPORT_ACTIONS.includes(actionTaken as any)) {
    updateData.actionTaken = actionTaken;
  }
  if (reviewNotes !== undefined) updateData.reviewNotes = reviewNotes;
  if (ncmecReportId !== undefined) updateData.ncmecReportId = ncmecReportId;

  // Action-time evidence snapshot — only fires for user-reported CSAM that
  // is being confirmed/actioned and that doesn't already carry an
  // upload-block snapshot. Privacy-by-design: false-positive CSAM reports
  // (which there will be many of, including weaponized accusations) never
  // freeze a forensic snapshot of the accused user's IP/UA because the
  // gate is human confirmation, not user submission.
  const isCsamConfirmation =
    report.reason === 'csam'
    && report.evidenceSource === null
    && (
      // Promote-to-actioned with reason=csam, OR explicit ncmec_report action.
      (status === 'actioned')
      || (actionTaken === 'ncmec_report')
    );
  let actionEvidence: Awaited<ReturnType<typeof snapshotActionTimeEvidence>> | null = null;
  if (isCsamConfirmation) {
    actionEvidence = await snapshotActionTimeEvidence(report);
    updateData.evidenceSource = actionEvidence.source;
    updateData.evidenceCapturedAt = new Date();
    if (actionEvidence.source === 'action-time-lookup') {
      updateData.uploaderIp = actionEvidence.ip;
      updateData.uploaderUserAgent = actionEvidence.ua;
    }
    // Mark preservation start if this report didn't already have one.
    if (!report.preservedAt) {
      updateData.preservedAt = new Date();
    }
    // Defense-in-depth identity fill. Reports created via /api/reports
    // already snapshot identity at create time (post-2026-04-27); but
    // legacy rows from before that change, or any future code path that
    // inserts a MessageReport without populating snapshot fields, would
    // otherwise lose identity to the SetNull cascade if the author later
    // self-deletes. Only fill what's actually missing — never overwrite
    // an existing snapshot with current User-row data, since the original
    // values are the legally meaningful ones.
    if (report.authorId && !report.authorUsernameSnapshot) {
      const authorSnapshot = await prisma.user.findUnique({
        where: { id: report.authorId },
        select: { username: true, discriminator: true, emailHash: true, createdAt: true },
      }).catch(() => null);
      if (authorSnapshot) {
        updateData.authorUsernameSnapshot = authorSnapshot.username;
        updateData.authorDiscriminatorSnapshot = authorSnapshot.discriminator;
        updateData.authorEmailHashSnapshot = authorSnapshot.emailHash;
        updateData.authorRegisteredAtSnapshot = authorSnapshot.createdAt;
      }
    }
    // SHA-256 fallback for user-reported content. Auto-flagged uploads
    // populate sha256 synchronously at upload-block time. User-reported
    // content (any media type) gets it from the ImageHash row written by
    // the same upload — looked up by attachmentUrl filename. Lets NCMEC
    // CyberTipline reports include cross-provider exact-match hashes for
    // video and audio CSAM, not just images.
    if (!report.sha256 && report.attachmentUrl) {
      const filename = report.attachmentUrl.split('/').pop();
      if (filename) {
        const mediaHash = await prisma.imageHash.findFirst({
          where: { filename, sha256: { not: null } },
          select: { sha256: true },
        }).catch(() => null);
        if (mediaHash?.sha256) {
          updateData.sha256 = mediaHash.sha256;
        }
      }
    }
  }

  const updated = await prisma.messageReport.update({
    where: { id: reportId },
    data: updateData,
  });

  await logAction(authReq.adminId!, 'report_review', report.authorId, {
    reportId,
    status: updated.status,
    actionTaken: updated.actionTaken,
  });

  if (updated.status !== 'pending') {
    try {
      const io = getIO();
      const payload = { reportId, status: updated.status, reason: report.reason };
      // reporterId is nullable (SetNull when reporter self-deletes).
      if (report.reporterId) {
        io.to(`user:${report.reporterId}`).emit('report-reviewed', payload);
      }
      // Only notify the author when actioned — don't leak dismissed reports.
      // authorId is now nullable (preserved-evidence reports outlive the user),
      // so skip when the author has already deleted their account.
      if (updated.status === 'actioned' && report.authorId && report.authorId !== report.reporterId) {
        io.to(`user:${report.authorId}`).emit('report-reviewed', payload);
      }
    } catch { /* notification delivery is best-effort */ }
  }

  res.json({
    id: updated.id,
    status: updated.status,
    actionTaken: updated.actionTaken,
    reviewNotes: updated.reviewNotes,
    ncmecReportId: updated.ncmecReportId,
    reviewedAt: updated.reviewedAt,
    reviewedBy: updated.reviewedBy,
    updatedAt: updated.updatedAt,
    // When this transition triggered an action-time evidence snapshot, tell
    // the admin UI whether the lookup actually found something. The UI
    // surfaces a warning on 'unavailable' so moderators don't assume IP/UA
    // were captured when they weren't.
    ...(actionEvidence ? { sessionEvidence: actionEvidence.source === 'action-time-lookup' ? 'captured' : 'unavailable' } : {}),
    evidenceSource: updated.evidenceSource,
  });
});

router.get('/reports/stats/summary', adminLimiter, async (_req, res: Response) => {
  const [pending, reviewed, actioned, dismissed, total] = await Promise.all([
    prisma.messageReport.count({ where: { status: 'pending' } }),
    prisma.messageReport.count({ where: { status: 'reviewed' } }),
    prisma.messageReport.count({ where: { status: 'actioned' } }),
    prisma.messageReport.count({ where: { status: 'dismissed' } }),
    prisma.messageReport.count(),
  ]);

  const csamReports = await prisma.messageReport.count({
    where: { reason: 'csam', status: { in: ['pending', 'reviewed'] } },
  });

  res.json({ pending, reviewed, actioned, dismissed, total, csamPending: csamReports });
});

// Flagged Hashes & Image Hashes

router.get('/flagged-hashes', adminLimiter, validate(adminFlaggedHashesQuery), async (req, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;
  const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;

  const where: Record<string, unknown> = {};
  if (reason) where.reason = reason;

  const [hashes, total] = await Promise.all([
    prisma.flaggedHash.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.flaggedHash.count({ where }),
  ]);

  res.json({ hashes, total, page, pages: Math.ceil(total / limit) });
});

router.post('/flagged-hashes', adminLimiter, validate(adminFlaggedHashValidation), async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const { hash, reason, source, notes } = req.body as { hash: string; reason: string; source?: string; notes?: string };

  const existing = await prisma.flaggedHash.findUnique({ where: { hash: hash.toLowerCase() } });
  if (existing) {
    return res.status(409).json({ error: 'Hash already flagged' });
  }

  const flagged = await prisma.flaggedHash.create({
    data: {
      hash: hash.toLowerCase(),
      reason,
      source: source || 'manual',
      addedById: authReq.adminId || null,
      notes: notes || null,
    },
  });

  publishFlaggedHashUpdate();
  // Run a retroactive sweep so prior uploads matching this hash are caught
  // and reported. Idempotent and Redis-locked, so multiple rapid hash adds
  // collapse into queued jobs without piling up.
  enqueueCleanup({ task: 'imageHashSweep' }).catch((err) =>
    log.error({ err }, 'failed to enqueue imageHashSweep after flagged-hash add'),
  );
  await logAction(authReq.adminId!, 'flagged_hash_add', null, { hash: flagged.hash, reason });

  res.status(201).json(flagged);
});

router.delete('/flagged-hashes/:id', adminLimiter, async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const id = validateUuidParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID format' });

  const existing = await prisma.flaggedHash.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Flagged hash not found' });

  await prisma.flaggedHash.delete({ where: { id } });
  await logAction(authReq.adminId!, 'flagged_hash_remove', null, { hash: existing.hash });

  res.json({ success: true });
});

router.get('/image-hashes', adminLimiter, validate(adminImageHashesQuery), async (req, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;
  const hash = typeof req.query.hash === 'string' ? req.query.hash : undefined;
  const flagMatch = req.query.flagMatch === 'true' ? true : undefined;

  // The admin "Recent Hash Matches" UI is PDQ-semantic — non-image uploads
  // (which carry sha256 only with hash=null) belong elsewhere, not here.
  const where: Record<string, unknown> = { hash: { not: null } };
  if (hash) where.hash = hash;
  if (flagMatch !== undefined) where.flagMatch = flagMatch;

  const [hashes, total] = await Promise.all([
    prisma.imageHash.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.imageHash.count({ where }),
  ]);

  const uploaderIds = [...new Set(hashes.map(h => h.uploaderId))];
  const users = await prisma.user.findMany({
    where: { id: { in: uploaderIds } },
    select: { id: true, username: true, discriminator: true, avatar: true },
    take: 200,
  });
  const userMap: Record<string, typeof users[0]> = {};
  users.forEach(u => { userMap[u.id] = u; });

  res.json({
    hashes: hashes.map(h => ({ ...h, uploader: userMap[h.uploaderId] || null })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// Trigger a retroactive sweep of ImageHash against the current FlaggedHash
// list. Returns 202 — the actual matching runs in the cleanup BullMQ worker
// (or inline when Redis is disabled). New matches show up in
// MessageReport (reason=csam) and the Recent Hash Matches table.
router.post('/flagged-hashes/sweep', adminLimiter, async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  await enqueueCleanup({ task: 'imageHashSweep' });
  await logAction(authReq.adminId!, 'image_hash_sweep_started', null, {});
  res.status(202).json({ message: 'Sweep started. New matches will appear in Reports and Recent Hash Matches once complete.' });
});

// Flagged Hash Snapshots (versioned ingestion)
//
// Lifecycle: begin → append (bulk) → activate (atomic swap) → [abort if needed].
//
// Only one snapshot per source can be `isActive=true` at any time. Manual
// FlaggedHash entries (snapshotId IS NULL) are always active and live
// alongside whichever external snapshot is currently active. Activation
// runs in a serializable transaction to prevent two admins racing.

const adminSnapshotBeginBody = z.object({
  source: z.enum(['ncmec', 'thorn', 'iwf', 'internal']),
  label: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
}).strict();
const adminSnapshotBeginValidation = z.object({ body: adminSnapshotBeginBody });

// Cap bulk-append at 10k hashes per request. Larger snapshots are uploaded
// in multiple batches; the snapshot remains in `isActive=false` staging the
// whole time so partial appends never leak into the live matching set.
const MAX_HASHES_PER_APPEND = 10_000;
const adminSnapshotAppendBody = z.object({
  hashes: z.array(z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hex string'),
    reason: z.enum(['csam', 'illegal', 'other']).default('csam'),
  })).min(1).max(MAX_HASHES_PER_APPEND),
}).strict();
const adminSnapshotAppendValidation = z.object({ body: adminSnapshotAppendBody });

router.get('/flagged-hash-snapshots', adminLimiter, async (_req, res: Response) => {
  const snapshots = await prisma.flaggedHashSnapshot.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ snapshots });
});

router.get('/flagged-hash-snapshots/:id', adminLimiter, async (req, res: Response) => {
  const id = validateUuidParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID format' });
  const snapshot = await prisma.flaggedHashSnapshot.findUnique({ where: { id } });
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  res.json(snapshot);
});

router.post('/flagged-hash-snapshots', adminLimiter, validate(adminSnapshotBeginValidation), async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const { source, label, notes } = req.body as z.infer<typeof adminSnapshotBeginBody>;
  const snapshot = await prisma.flaggedHashSnapshot.create({
    data: {
      source,
      label: label ?? null,
      notes: notes ?? null,
      createdById: authReq.adminId ?? null,
      isActive: false,
    },
  });
  await logAction(authReq.adminId!, 'flagged_hash_snapshot_begin', null, { snapshotId: snapshot.id, source });
  res.status(201).json(snapshot);
});

router.post('/flagged-hash-snapshots/:id/append', adminLimiter, validate(adminSnapshotAppendValidation), async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const id = validateUuidParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID format' });
  const snapshot = await prisma.flaggedHashSnapshot.findUnique({ where: { id } });
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  if (snapshot.isActive) {
    // Once a snapshot is live we don't allow append — that would mutate the
    // matching set out from under in-flight uploads. Begin a new snapshot,
    // append, activate it, and the old one auto-deactivates.
    return res.status(409).json({ error: 'Cannot append to an active snapshot. Begin a new one instead.' });
  }
  if (snapshot.abortedAt) return res.status(409).json({ error: 'Snapshot was aborted; begin a new one.' });

  const { hashes } = req.body as z.infer<typeof adminSnapshotAppendBody>;
  // skipDuplicates so partial-retry on a dropped connection doesn't fail
  // the whole append. Per-snapshot uniqueness on (snapshotId, hash) is not
  // currently enforced (FlaggedHash.hash is globally unique), so a hash
  // already in the manual table will be silently skipped here too.
  const result = await prisma.flaggedHash.createMany({
    data: hashes.map(h => ({
      hash: h.hash.toLowerCase(),
      reason: h.reason,
      source: snapshot.source,
      addedById: authReq.adminId ?? null,
      snapshotId: id,
    })),
    skipDuplicates: true,
  });
  await prisma.flaggedHashSnapshot.update({
    where: { id },
    data: { hashCount: { increment: result.count } },
  });
  await logAction(authReq.adminId!, 'flagged_hash_snapshot_append', null, {
    snapshotId: id, requested: hashes.length, inserted: result.count,
  });
  res.json({ inserted: result.count, requested: hashes.length });
});

router.post('/flagged-hash-snapshots/:id/activate', adminLimiter, async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const id = validateUuidParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID format' });
  const snapshot = await prisma.flaggedHashSnapshot.findUnique({ where: { id } });
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  if (snapshot.isActive) return res.status(409).json({ error: 'Snapshot is already active' });
  if (snapshot.abortedAt) return res.status(409).json({ error: 'Snapshot was aborted' });

  // Atomic swap inside a Serializable tx so two parallel activations
  // can't both succeed and leave two snapshots from the same source live.
  await prisma.$transaction(async (tx) => {
    await tx.flaggedHashSnapshot.updateMany({
      where: { source: snapshot.source, isActive: true },
      data: { isActive: false },
    });
    await tx.flaggedHashSnapshot.update({
      where: { id },
      data: { isActive: true, activatedAt: new Date() },
    });
  }, { isolationLevel: 'Serializable' });

  publishFlaggedHashUpdate();
  enqueueCleanup({ task: 'imageHashSweep' }).catch((err) =>
    log.error({ err }, 'failed to enqueue sweep after snapshot activate'),
  );
  await logAction(authReq.adminId!, 'flagged_hash_snapshot_activate', null, {
    snapshotId: id, source: snapshot.source, hashCount: snapshot.hashCount,
  });
  res.json({ success: true });
});

router.post('/flagged-hash-snapshots/:id/abort', adminLimiter, async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const id = validateUuidParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID format' });
  const snapshot = await prisma.flaggedHashSnapshot.findUnique({ where: { id } });
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  if (snapshot.isActive) {
    return res.status(409).json({ error: 'Cannot abort an active snapshot. Activate a different one first to deactivate this one.' });
  }
  // Cascade on snapshotId removes the staged FlaggedHash rows in one shot.
  await prisma.flaggedHashSnapshot.delete({ where: { id } });
  await logAction(authReq.adminId!, 'flagged_hash_snapshot_abort', null, {
    snapshotId: id, source: snapshot.source, hashCount: snapshot.hashCount,
  });
  res.json({ success: true });
});

router.post('/flagged-hashes/from-report', adminLimiter, validate(adminFlagFromReportValidation), async (req, res: Response) => {
  const authReq = req as AdminAuthRequest;
  const { reportId, reason } = req.body as { reportId: string; reason?: string };

  const report = await prisma.messageReport.findUnique({ where: { id: reportId } });
  if (!report || !report.attachmentUrl) {
    return res.status(404).json({ error: 'Report not found or has no attachment' });
  }

  const filename = report.attachmentUrl.split('/').pop();
  if (!filename) {
    return res.status(400).json({ error: 'Cannot extract filename from attachment URL' });
  }
  // hash is nullable post-2026-04-27 (non-image uploads carry sha256 only).
  // The flag-from-report flow specifically adds the PDQ hash to the flagged
  // list, so we need a row that actually has one.
  const imageHash = await prisma.imageHash.findFirst({
    where: { filename: { contains: filename }, hash: { not: null } },
  });
  if (!imageHash || !imageHash.hash) {
    return res.status(404).json({ error: 'No PDQ hash found for this attachment (likely a non-image upload)' });
  }

  const existing = await prisma.flaggedHash.findUnique({ where: { hash: imageHash.hash } });
  if (existing) {
    return res.status(409).json({ error: 'Hash already flagged' });
  }

  const flagged = await prisma.flaggedHash.create({
    data: {
      hash: imageHash.hash,
      reason: reason || 'csam',
      source: 'manual',
      addedById: authReq.adminId || null,
      notes: `From report ${reportId}`,
    },
  });

  publishFlaggedHashUpdate();
  await prisma.imageHash.update({ where: { id: imageHash.id }, data: { flagMatch: true } });
  enqueueCleanup({ task: 'imageHashSweep' }).catch((err) =>
    log.error({ err }, 'failed to enqueue imageHashSweep after flag-from-report'),
  );

  await logAction(authReq.adminId!, 'flagged_hash_from_report', report.authorId, { reportId, hash: flagged.hash });

  res.status(201).json(flagged);
});

export default router;
