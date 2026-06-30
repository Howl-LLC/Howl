// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import {
  mlsPublishKeyPackagesSchema,
  mlsKeyPackageUserParamSchema,
  mlsKeyPackageCountQuerySchema,
  mlsCreateGroupSchema,
  mlsSubmitCommitSchema,
  mlsGroupIdParamSchema,
  mlsGroupResetSchema,
  mlsCommitCatchupSchema,
  mlsWelcomesQuerySchema,
} from '../schemas.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import { isKpConsumeRateLimited, recordKpConsume, isKpConsumeCallerLimited, recordKpConsumeCaller, shouldSignalKpLowWater } from '../redis.js';
import { getIO } from '../socketIO.js';
import { validateAndBindKeyPackage } from '../mls/as.js';
import { classifyCommit } from '../mls/admission.js';
import { parseRemovedLeaves, mapLeafIndicesToUserIds, parseAddedLeaves } from '../mls/removeAuthz.js';
import { b64ToBuf, bufToB64 } from '../mls/serialization.js';
import { MLS_CIPHERSUITE_ID } from '../mls/ciphersuite.js';
import { hasBlockBetween } from './dmHelpers.js';

const router = Router();

// per-device single-use pool ceiling.
export const MLS_KEYPACKAGE_POOL_CAP = 100;

// A creator advances epoch-0 -> 1 within seconds; only a genuinely abandoned
// epoch-0 group (stranded by an establish failure) is older than this and safe
// to replace.
export const GROUP_HEAL_GRACE_MS = 10 * 60 * 1000;

const mlsKeyPackageLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:mls-kp:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const mlsReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:mls-read:'),
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const mlsCommitLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:mls-commit:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Group reset is a rare manual recovery op; throttle it tightly (it also amplifies a
// re-establish storm across the peer, so keep the ceiling well below the commit limiter).
const mlsResetLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:mls-reset:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many reset attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// POST /api/v1/mls/keypackages — publish a batch (AS bind + pool cap + last-resort rotation).
router.post(
  '/keypackages',
  authenticateToken,
  mlsKeyPackageLimiter,
  validate(mlsPublishKeyPackagesSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const { deviceId, keyPackages } = req.body as {
      deviceId: string;
      keyPackages: { keyPackage: string; isLastResort: boolean }[];
    };

    // Cross-sig gate: the publisher's account AIK (DmKeyBundle.signingPublicKey)
    // must match the AIK embedded in every published KeyPackage's credential. Fetch it
    // once; the AS fails closed (no_aik) if the account has none on file.
    const publisher = await prisma.dmKeyBundle.findUnique({
      where: { userId: req.userId },
      select: { signingPublicKey: true },
    });
    const publisherAik = publisher?.signingPublicKey ?? null;

    // AS-bind every KeyPackage before any DB work; reject the whole batch on the
    // first bad one (no partial publish).
    const bound: { keyPackage: Uint8Array<ArrayBuffer>; keyPackageRef: string; notAfter: Date; isLastResort: boolean }[] = [];
    for (const item of keyPackages) {
      const r = await validateAndBindKeyPackage(item.keyPackage, req.userId, deviceId, publisherAik, item.isLastResort);
      if (!r.ok) {
        logger.warn({ userId: req.userId, deviceId, reason: r.reason }, 'MLS keypackage publish rejected');
        return res.status(400).json({ error: 'invalid_keypackage', reason: r.reason });
      }
      bound.push({
        keyPackage: Uint8Array.from(b64ToBuf(item.keyPackage)),
        keyPackageRef: r.keyPackageRef,
        notAfter: r.notAfter,
        isLastResort: item.isLastResort,
      });
    }

    const singleUseNew = bound.filter((b) => !b.isLastResort);
    const hasLastResort = bound.some((b) => b.isLastResort);

    const result = await prisma.$transaction(async (tx) => {
      const available = await tx.mlsKeyPackage.count({
        where: { userId: req.userId!, deviceId, isLastResort: false, consumedAt: null, notAfter: { gt: new Date() } },
      });
      if (available + singleUseNew.length > MLS_KEYPACKAGE_POOL_CAP) return { error: 'pool_full' as const };
      // Rotate last-resort: a device keeps at most one, so a new one replaces the old.
      if (hasLastResort) {
        await tx.mlsKeyPackage.deleteMany({ where: { userId: req.userId!, deviceId, isLastResort: true } });
      }
      await tx.mlsKeyPackage.createMany({
        data: bound.map((b) => ({
          userId: req.userId!,
          deviceId,
          keyPackageRef: b.keyPackageRef,
          keyPackage: b.keyPackage,
          isLastResort: b.isLastResort,
          notAfter: b.notAfter,
        })),
        skipDuplicates: true, // idempotent republish via keyPackageRef @unique
      });
      const remaining = await tx.mlsKeyPackage.count({
        where: { userId: req.userId!, deviceId, isLastResort: false, consumedAt: null, notAfter: { gt: new Date() } },
      });
      return { remaining };
    });

    if ('error' in result) return res.status(409).json({ error: 'pool_full' });
    logger.info(
      { userId: req.userId, deviceId, published: bound.length, remaining: result.remaining },
      'MLS keypackages published',
    );
    return res.status(201).json({ published: bound.length, remaining: result.remaining });
  }),
);

// GET /keypackages/count — own pool remaining (low-water signal). Declared BEFORE
// the :userId param route so the literal path matches first.
router.get(
  '/keypackages/count',
  authenticateToken,
  mlsReadLimiter,
  validate(mlsKeyPackageCountQuerySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const deviceId = req.query.deviceId as string;
    const remaining = await prisma.mlsKeyPackage.count({
      where: { userId: req.userId, deviceId, isLastResort: false, consumedAt: null, notAfter: { gt: new Date() } },
    });
    const hasLastResort =
      (await prisma.mlsKeyPackage.count({ where: { userId: req.userId, deviceId, isLastResort: true, notAfter: { gt: new Date() } } })) > 0;
    return res.json({ remaining, hasLastResort });
  }),
);

// GET /keypackages/:userId — atomically consume one available KeyPackage per
// target device (prefer single-use, fall back to last-resort). Tombstones via
// consumedAt; last-resort rows are reusable (never consumed). Per-target bound.
router.get(
  '/keypackages/:userId',
  validateUuidParams('userId'),
  authenticateToken,
  mlsReadLimiter,
  validate(mlsKeyPackageUserParamSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const callerId = req.userId;
    const targetUserId = req.params.userId as string;

    // A per-(caller,target) bound so ONE abuser cannot spend the shared
    // per-target budget and 429 every legitimate group-adder of this victim.
    if (await isKpConsumeCallerLimited(callerId, targetUserId)) {
      return res.status(429).json({ error: 'KeyPackage consume rate exceeded' });
    }
    if (await isKpConsumeRateLimited(targetUserId)) {
      return res.status(429).json({ error: 'KeyPackage consume rate exceeded for this target' });
    }

    // Trust & Safety: a block in either direction must not let the caller drain
    // or reach the target's pool (mirrors the block guard on
    // dmKeys.ts GET /public-key/:userId).
    if (await hasBlockBetween(callerId, targetUserId)) {
      return res.status(403).json({ error: 'Cannot fetch KeyPackages for this user' });
    }

    // Distinct target devices that have any live package.
    const devices = await prisma.mlsKeyPackage.findMany({
      where: { userId: targetUserId, notAfter: { gt: new Date() } },
      select: { deviceId: true },
      distinct: ['deviceId'],
      take: 50,
    });
    if (devices.length === 0) return res.status(404).json({ error: 'No KeyPackages for this user' });

    const out: { deviceId: string; keyPackage: string; keyPackageRef: string; isLastResort: boolean }[] = [];

    for (const { deviceId } of devices) {
      const candidate = await prisma.mlsKeyPackage.findFirst({
        where: { userId: targetUserId, deviceId, isLastResort: false, consumedAt: null, notAfter: { gt: new Date() } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, keyPackage: true, keyPackageRef: true },
      });
      if (candidate) {
        const claimed = await prisma.mlsKeyPackage.updateMany({
          where: { id: candidate.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (claimed.count === 1) {
          out.push({ deviceId, keyPackage: bufToB64(candidate.keyPackage), keyPackageRef: candidate.keyPackageRef, isLastResort: false });
          continue;
        }
        // Lost the race for this row; fall through to last-resort.
      }
      const lastResort = await prisma.mlsKeyPackage.findFirst({
        where: { userId: targetUserId, deviceId, isLastResort: true, notAfter: { gt: new Date() } },
        select: { keyPackage: true, keyPackageRef: true },
      });
      if (lastResort) {
        out.push({ deviceId, keyPackage: bufToB64(lastResort.keyPackage), keyPackageRef: lastResort.keyPackageRef, isLastResort: true });
      }
    }

    if (out.length === 0) return res.status(404).json({ error: 'No available KeyPackages for this user' });

    // Charge BOTH consume limiters by the number of single-use packages
    // ACTUALLY drained this request (reflects true pool drain; reusable
    // last-resort serves drain nothing and are not counted). Per-package on both
    // keeps the per-(caller,target) budget dimensionally comparable to the
    // per-target aggregate, so one caller cannot saturate the shared budget.
    const singleUseConsumed = out.filter((p) => !p.isLastResort).length;
    if (singleUseConsumed > 0) {
      await recordKpConsumeCaller(callerId, targetUserId, singleUseConsumed);
      await recordKpConsume(targetUserId, singleUseConsumed);
    }

    // A last-resort serve means the victim's single-use pool is
    // drained (forward secrecy degrading). Signal the victim — debounced, no
    // callerId — so the degradation isn't silent. Best-effort: getIO() throws
    // before the socket server is wired (e.g. tests), so swallow.
    if (out.some((p) => p.isLastResort) && (await shouldSignalKpLowWater(targetUserId))) {
      try {
        getIO().to(`user:${targetUserId}`).emit('mls-keypackage-low-water', { reason: 'last-resort-served' });
      } catch { /* socket server not initialised — skip the best-effort signal */ }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ keyPackages: out });
  }),
);

// POST /groups — create-once for (dmChannelId, tier) at epoch 0.
router.post(
  '/groups',
  authenticateToken,
  mlsKeyPackageLimiter,
  validate(mlsCreateGroupSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const { dmChannelId, tier, groupInfo } = req.body as { dmChannelId: string; tier: 'saved' | 'otr'; groupInfo: string };

    // Admission: caller must be an app-authorized participant of the channel.
    const participant = await prisma.dMParticipant.findFirst({
      where: { dmChannelId, userId: req.userId },
      select: { userId: true },
    });
    if (!participant) return res.status(403).json({ error: 'Not a participant of this DM channel' });

    // OTR eligibility: bilateral-Private + 1:1. Server-authoritative; the
    // client check is UX-only. Generic error — never leak WHICH participant is
    // ineligible (preserves the counterparty's recovery-mode privacy).
    if (tier === 'otr') {
      const OTR_INELIGIBLE = { error: 'Off the Record is not available for this chat' };
      const channel = await prisma.dMChannel.findUnique({
        where: { id: dmChannelId },
        select: { isGroup: true, participants: { select: { userId: true }, take: 1000 } },
      });
      if (!channel || channel.isGroup) return res.status(403).json(OTR_INELIGIBLE);
      const participantIds = channel.participants.map((p) => p.userId);
      const bundles = await prisma.dmKeyBundle.findMany({
        where: { userId: { in: participantIds } },
        select: { userId: true, passwordDerived: true },
        take: 1000,
      });
      const privateById = new Map(bundles.map((b) => [b.userId, b.passwordDerived === false]));
      const allPrivate = participantIds.length >= 2
        && participantIds.every((uid) => privateById.get(uid) === true);
      if (!allPrivate) return res.status(403).json(OTR_INELIGIBLE);
    }

    try {
      const group = await prisma.mlsGroup.create({
        data: {
          dmChannelId,
          tier,
          cipherSuite: MLS_CIPHERSUITE_ID,
          currentEpoch: 0n,
          groupInfo: Uint8Array.from(b64ToBuf(groupInfo)), // Prisma 7 Bytes wants Uint8Array<ArrayBuffer>
          groupInfoEpoch: 0n,
        },
        select: { id: true, currentEpoch: true },
      });
      logger.info({ userId: req.userId, dmChannelId, tier, groupId: group.id }, 'MLS group created');
      return res.status(201).json({ groupId: group.id, currentEpoch: group.currentEpoch.toString() });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Self-heal: a stale epoch-0 row is an abandoned create (the KeyPackage consume
        // 404'd after this row was minted, stranding the channel). An epoch-0 row has no
        // committed members beyond the creator's claimed GroupInfo and no Welcomes
        // (Welcomes are written only by submitCommit, which advances the epoch past 0),
        // so replacing it orphans nothing. Serializable isolation makes concurrent heals
        // resolve to exactly one winner.
        try {
          const result = await prisma.$transaction(async (tx) => {
            const existing = await tx.mlsGroup.findUnique({
              where: { dmChannelId_tier: { dmChannelId, tier } },
              select: { id: true, currentEpoch: true, createdAt: true },
            });
            if (!existing) return { kind: 'retry' as const }; // row vanished between create and read
            const isStaleEpoch0 = existing.currentEpoch === 0n
              && existing.createdAt.getTime() < Date.now() - GROUP_HEAL_GRACE_MS;
            if (!isStaleEpoch0) return { kind: 'conflict' as const };
            await tx.mlsGroup.delete({ where: { id: existing.id } });
            const replacement = await tx.mlsGroup.create({
              data: {
                dmChannelId,
                tier,
                cipherSuite: MLS_CIPHERSUITE_ID,
                currentEpoch: 0n,
                groupInfo: Uint8Array.from(b64ToBuf(groupInfo)),
                groupInfoEpoch: 0n,
              },
              select: { id: true, currentEpoch: true },
            });
            return { kind: 'healed' as const, group: replacement };
          }, { isolationLevel: 'Serializable' });

          if (result.kind === 'healed') {
            logger.info({ userId: req.userId, dmChannelId, tier, groupId: result.group.id }, 'MLS group epoch-0 self-healed');
            return res.status(201).json({ groupId: result.group.id, currentEpoch: result.group.currentEpoch.toString() });
          }
          // 'conflict' (live or non-stale group) and 'retry' (row vanished) both fail closed as 409.
          return res.status(409).json({ error: 'MLS group already exists for this channel/tier' });
        } catch (txErr) {
          // A racing heal won (P2034 serialization failure, or a unique-create P2002 inside
          // the tx). Fail closed as a normal conflict; the client re-establishes on retry.
          if (txErr instanceof Prisma.PrismaClientKnownRequestError && (txErr.code === 'P2034' || txErr.code === 'P2002')) {
            return res.status(409).json({ error: 'MLS group already exists for this channel/tier' });
          }
          throw txErr;
        }
      }
      throw err;
    }
  }),
);

// GET /groups/:groupId/group-info — current GroupInfo for External-Commit join.
router.get(
  '/groups/:groupId/group-info',
  validateUuidParams('groupId'),
  authenticateToken,
  mlsReadLimiter,
  validate(mlsGroupIdParamSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const groupId = req.params.groupId as string;
    const group = await prisma.mlsGroup.findUnique({
      where: { id: groupId },
      select: { dmChannelId: true, groupInfo: true, groupInfoEpoch: true },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const participant = await prisma.dMParticipant.findFirst({ where: { dmChannelId: group.dmChannelId, userId: req.userId, pendingRemoval: null }, select: { userId: true } });
    if (!participant) return res.status(403).json({ error: 'Not a participant of this DM channel' });
    if (!group.groupInfo) return res.status(404).json({ error: 'No GroupInfo published' });

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ groupInfo: bufToB64(group.groupInfo), groupInfoEpoch: (group.groupInfoEpoch ?? 0n).toString() });
  }),
);

// POST /groups/:groupId/reset — manual teardown of a STRANDED 1:1 MLS group, so the
// pair re-establishes a fresh group on next open. This is recovery for the cohort that
// predates the AIK rotation-attestation chain (post-attestation rotations never strand,
// so they never need this). Strictly scoped:
//  - 1:1 only. A group DM's reset must go through operator/quorum, not a single member.
//  - caller must be a participant with pendingRemoval:null.
//  - expectedEpoch binds the caller's view (TOCTOU): the delete only fires if the group
//    is still at the epoch the caller saw.
//  - Serializable + idempotent: a concurrent/duplicate reset resolves to one winner; a
//    group already gone is treated as success.
//  - deletes the MlsGroup (cascade MlsCommit) + its MlsWelcomes (no FK cascade), then
//    signals both participants to drop and re-establish.
router.post(
  '/groups/:groupId/reset',
  validateUuidParams('groupId'),
  authenticateToken,
  mlsResetLimiter,
  validate(mlsGroupResetSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const groupId = req.params.groupId as string;
    const { expectedEpoch } = req.body as { expectedEpoch: string };

    const group = await prisma.mlsGroup.findUnique({
      where: { id: groupId },
      select: { id: true, dmChannelId: true, dmChannel: { select: { isGroup: true } } },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.dmChannel?.isGroup) {
      return res.status(403).json({ error: 'Group DMs cannot be reset by a single participant' });
    }
    const participant = await prisma.dMParticipant.findFirst({
      where: { dmChannelId: group.dmChannelId, userId: req.userId, pendingRemoval: null },
      select: { userId: true },
    });
    if (!participant) return res.status(403).json({ error: 'Not a participant of this DM channel' });

    // Block guard (mirror GET /keypackages/:userId and /public-key): a blocked
    // relationship must not use reset to tear down the shared 1:1 — re-establishment
    // would 403 on the block in both directions, leaving the pair stranded.
    const others = await prisma.dMParticipant.findMany({
      where: { dmChannelId: group.dmChannelId, userId: { not: req.userId } },
      select: { userId: true },
      take: 10,
    });
    for (const o of others) {
      if (await hasBlockBetween(req.userId, o.userId)) {
        return res.status(403).json({ error: 'Cannot reset a conversation with a blocked user' });
      }
    }

    let expected: bigint;
    try { expected = BigInt(expectedEpoch); } catch { return res.status(400).json({ error: 'Invalid expectedEpoch' }); }

    let result: { kind: 'reset' | 'gone' } | { kind: 'epoch_conflict'; currentEpoch: string };
    try {
      result = await prisma.$transaction(async (tx) => {
        const live = await tx.mlsGroup.findUnique({ where: { id: groupId }, select: { id: true, currentEpoch: true } });
        if (!live) return { kind: 'gone' as const }; // already reset by a concurrent caller (idempotent)
        if (live.currentEpoch !== expected) {
          return { kind: 'epoch_conflict' as const, currentEpoch: live.currentEpoch.toString() };
        }
        // MlsCommit cascades on the MlsGroup delete; MlsWelcome has no FK cascade.
        await tx.mlsWelcome.deleteMany({ where: { groupId } });
        await tx.mlsGroup.delete({ where: { id: groupId } });
        return { kind: 'reset' as const };
      }, { isolationLevel: 'Serializable' });
    } catch (txErr) {
      if (txErr instanceof Prisma.PrismaClientKnownRequestError && (txErr.code === 'P2034' || txErr.code === 'P2025')) {
        // A racing reset won (serialization failure or the row vanished mid-delete):
        // idempotent success.
        result = { kind: 'gone' };
      } else {
        throw txErr;
      }
    }

    if (result.kind === 'epoch_conflict') {
      return res.status(409).json({ error: 'Group epoch changed; refetch and retry', currentEpoch: result.currentEpoch });
    }

    if (result.kind === 'reset') {
      logger.info({ userId: req.userId, dmChannelId: group.dmChannelId, groupId }, 'MLS 1:1 group reset (manual recovery)');
      try {
        const participants = await prisma.dMParticipant.findMany({
          where: { dmChannelId: group.dmChannelId, pendingRemoval: null },
          select: { userId: true },
          take: 1000,
        });
        const io = req.app.get('io') as import('socket.io').Server | undefined;
        if (io) {
          for (const { userId } of participants) {
            io.to(`user:${userId}`).emit('mls-group-reset', { dmChannelId: group.dmChannelId, mlsGroupId: groupId });
          }
        }
      } catch (relayErr) {
        logger.warn({ err: relayErr, groupId }, 'MLS group-reset fan-out failed; clients recover on next open');
      }
    }

    return res.json({ success: true });
  }),
);

// POST /groups/:groupId/commits — CAS-ordered commit submission (member + external).
// Member-mode CAS below.
router.post(
  '/groups/:groupId/commits',
  validateUuidParams('groupId'),
  authenticateToken,
  mlsCommitLimiter,
  validate(mlsSubmitCommitSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const groupId = req.params.groupId as string;
    const { baseEpoch, mode, commit, groupInfo, idempotencyKey, welcomes, removedUserIds } = req.body as {
      baseEpoch: string;
      mode: 'member' | 'external';
      commit: string;
      groupInfo: string;
      idempotencyKey: string;
      welcomes?: { recipientId: string; welcomeData: string }[];
      removedUserIds?: string[];
    };

    const group = await prisma.mlsGroup.findUnique({
      where: { id: groupId },
      select: { id: true, dmChannelId: true, currentEpoch: true, groupInfoEpoch: true, groupInfo: true, dmChannel: { select: { isGroup: true } } },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const isGroup = group.dmChannel?.isGroup ?? false;

    // Admission (pre-check): submitter is an app-authorized participant who is NOT on
    // their way out. `pendingRemoval: null` rejects a member whose Remove has been
    // marked but not yet finalized (the row lingers pre-commit): otherwise a removed
    // member with a wiped IndexedDB could External-Commit their own leaf back into the
    // tree, racing the Remove. Mirrors the Welcome-recipient admission below.
    const participant = await prisma.dMParticipant.findFirst({
      where: { dmChannelId: group.dmChannelId, userId: req.userId, pendingRemoval: null },
      select: { userId: true },
    });
    if (!participant) return res.status(403).json({ error: 'Not a participant of this DM channel' });

    // Admission: well-formed MLSMessage of the correct wireformat (decode a COPY).
    const classified = classifyCommit(b64ToBuf(commit));
    if (!classified.ok) return res.status(400).json({ error: 'invalid_commit', reason: classified.reason });
    // External commits are public; 1:1 member commits stay private; GROUP member
    // commits MUST be public so the server-side Remove-authz gate (parseRemovedLeaves
    // + the pendingRemoval check below) can read their proposals. This closes a seam
    // where a PRIVATE group member commit slipped past that gate,
    // letting a non-owner inline-Remove an arbitrary leaf (parseRemovedLeaves cannot
    // read an encrypted PrivateMessage, so removeTargets stayed empty and the
    // forbidden_remove check never fired). The current client always wires group
    // member commits as public (commitAddMembersWithRebase / commitRemoveMembersWithRebase
    // pass wireAsPublicMessage=true). See docs/PROTOCOL_CHANGES.md: hard
    // tightening, no deployed old clients, no protocolVersion bump.
    if (mode === 'external') {
      if (classified.wireformat !== 'mls_public_message') {
        return res.status(400).json({ error: 'invalid_commit', reason: 'wrong_wireformat' });
      }
    } else if (!isGroup) {
      if (classified.wireformat !== 'mls_private_message') {
        return res.status(400).json({ error: 'invalid_commit', reason: 'wrong_wireformat' });
      }
    } else {
      // mode === 'member' && isGroup — require public.
      if (classified.wireformat !== 'mls_public_message') {
        return res.status(400).json({ error: 'invalid_commit', reason: 'wrong_wireformat' });
      }
    }

    // External commits bind N to the wire epoch (authoritative); member commits use the
    // client-named baseEpoch (validated by the CAS).
    const N = mode === 'external' ? classified.baseEpoch : BigInt(baseEpoch);

    // Remove authority: read the inline Remove targets from a PUBLIC commit and
    // resolve them to userIds via the stored (pre-commit, epoch-N) ratchet tree.
    // This runs for BOTH group member commits (owner-only kick) AND external
    // commits. An external commit is also public-wireformat and can carry an inline
    // Remove (RFC 9420 §12.4.3.2 — the resync path legitimately drops the joiner's
    // OWN stale leaf), so it must be authorized too: the server does NO crypto
    // validation of external commits (admission.ts), and ts-mls's validateExternalInit
    // does not constrain the Remove target, so an unguarded external_init + Remove(victim)
    // let any participant cryptographically evict an arbitrary member without owner
    // authorization. See docs/PROTOCOL_CHANGES.md. Skip when the group
    // already advanced past N (the CAS returns a conflict; a newer tree would
    // mis-resolve the leaf indices).
    let removeTargets: string[] = [];
    const runRemoveGate = classified.wireformat === 'mls_public_message' && (mode === 'external' || (mode === 'member' && isGroup));
    if (runRemoveGate) {
      const parsed = parseRemovedLeaves(Uint8Array.from(b64ToBuf(commit)));
      if (!parsed.ok) return res.status(400).json({ error: 'invalid_commit', reason: parsed.reason });
      if (parsed.leaves.length > 0 && group.currentEpoch === N) {
        if (!group.groupInfo) return res.status(400).json({ error: 'invalid_commit', reason: 'no_tree' });
        const mapped = mapLeafIndicesToUserIds(Uint8Array.from(group.groupInfo), parsed.leaves);
        if (!mapped.ok) return res.status(400).json({ error: 'invalid_commit', reason: mapped.reason });
        // External resync carve-out: an external committer may remove ONLY its own
        // prior leaf (the documented self-resync). Filtering self out of the external
        // target set lets the legit resync through (the committer is an active
        // participant, not pendingRemoval) while every OTHER removed target — and
        // EVERY target of a member commit — must be owner-marked pendingRemoval,
        // enforced by the in-transaction gate below.
        removeTargets = mode === 'external'
          ? mapped.userIds.filter((uid) => uid !== req.userId)
          : mapped.userIds;
      }
    }

    // Add authority: for a PUBLIC group member commit, read the Add targets'
    // userIds directly from the commit (each Add embeds the new member's full
    // KeyPackage, so no GroupInfo/ratchet-tree lookup is needed, unlike Remove).
    let addTargets: string[] = [];
    if (mode === 'member' && isGroup && classified.wireformat === 'mls_public_message') {
      const parsedAdds = parseAddedLeaves(Uint8Array.from(b64ToBuf(commit)));
      if (!parsedAdds.ok) return res.status(400).json({ error: 'invalid_commit', reason: parsedAdds.reason });
      addTargets = parsedAdds.userIds;
    }

    // Admission: every Welcome recipient must be a participant of this channel.
    // (Closes a P2003 FK-violation -> 500 path that would roll back an accepted commit,
    // and prevents sealing dead-drops to arbitrary users.)
    let dedupedWelcomes = welcomes;
    if (welcomes?.length) {
      const recipientIds = [...new Set(welcomes.map((w) => w.recipientId))];
      const participants = await prisma.dMParticipant.findMany({
        where: { dmChannelId: group.dmChannelId, userId: { in: recipientIds }, pendingRemoval: null },
        select: { userId: true },
        take: 50,
      });
      const allowed = new Set(participants.map((p) => p.userId));
      if (!recipientIds.every((id) => allowed.has(id))) {
        return res.status(400).json({ error: 'invalid_welcome', reason: 'recipient_not_participant' });
      }
      // Dedupe by recipientId (keep first) so a duplicate in welcomes[] does not collide on
      // @@unique([recipientId, groupId, epoch]) inside the tx and surface a misleading 409.
      const seen = new Set<string>();
      dedupedWelcomes = welcomes.filter((w) => (seen.has(w.recipientId) ? false : (seen.add(w.recipientId), true)));
    }

    // Fast-path idempotency: a timed-out-but-accepted resubmit returns the original outcome.
    const pre = await prisma.mlsCommit.findUnique({
      where: { groupId_idempotencyKey: { groupId, idempotencyKey } },
      select: { id: true, epoch: true },
    });
    if (pre) return res.json({ epoch: (pre.epoch + 1n).toString(), commitId: pre.id, idempotent: true });

    const groupInfoBuf = Uint8Array.from(b64ToBuf(groupInfo));
    const commitBuf = Uint8Array.from(b64ToBuf(commit));

    let result: { kind: 'ok'; commitId: string } | { kind: 'conflict' } | { kind: 'forbidden' } | { kind: 'forbidden_remove' } | { kind: 'forbidden_add' };
    try {
      result = await prisma.$transaction(async (tx) => {
        // In-transaction admission (atomic with the CAS): re-confirm participant, closing the
        // TOCTOU window (a participant removed OR marked pendingRemoval mid-flight must not
        // slip through). `pendingRemoval: null` mirrors the pre-check above.
        const stillMember = await tx.dMParticipant.findFirst({
          where: { dmChannelId: group.dmChannelId, userId: req.userId!, pendingRemoval: null },
          select: { userId: true },
        });
        if (!stillMember) return { kind: 'forbidden' as const };

        // Every removed user must already be pendingRemoval (owner-authorized
        // at the REST kick route, or a self-leave). Authoritative, in-tx.
        if (removeTargets.length > 0) {
          const authorized = await tx.dMParticipant.findMany({
            where: { dmChannelId: group.dmChannelId, userId: { in: removeTargets }, pendingRemoval: { not: null } },
            select: { userId: true },
            take: 50,
          });
          const okSet = new Set(authorized.map((p) => p.userId));
          if (!removeTargets.every((uid) => okSet.has(uid))) return { kind: 'forbidden_remove' as const };
        }

        // Add-authz: every added user must be a current DMParticipant (not pending removal).
        if (addTargets.length > 0) {
          const authorized = await tx.dMParticipant.findMany({
            where: { dmChannelId: group.dmChannelId, userId: { in: addTargets }, pendingRemoval: null },
            select: { userId: true },
            take: 50,
          });
          const okSet = new Set(authorized.map((p) => p.userId));
          if (!addTargets.every((uid) => okSet.has(uid))) return { kind: 'forbidden_add' as const };
        }

        // CAS: advance N -> N+1 and republish GroupInfo together. A loser's WHERE fails.
        const cas = await tx.mlsGroup.updateMany({
          where: { id: groupId, currentEpoch: N },
          data: { currentEpoch: N + 1n, groupInfo: groupInfoBuf, groupInfoEpoch: N + 1n },
        });
        if (cas.count === 0) return { kind: 'conflict' as const };

        // Gated commit-log append; (groupId,epoch) and (groupId,idempotencyKey) P2002 -> rolls back the CAS.
        const commitRow = await tx.mlsCommit.create({
          data: { groupId, epoch: N, commitData: commitBuf, idempotencyKey },
          select: { id: true },
        });

        if (dedupedWelcomes?.length) {
          for (const w of dedupedWelcomes) {
            await tx.mlsWelcome.create({
              data: { recipientId: w.recipientId, groupId, epoch: N + 1n, welcomeData: Uint8Array.from(b64ToBuf(w.welcomeData)) },
            });
          }
        }

        // Advisory finalize (NOT authz — owner-only lives at the kick route): on the accepted
        // CAS, delete ONLY participants that are BOTH named in the hint AND already marked
        // pendingRemoval. Never delete an unmarked participant. Atomic with the CAS.
        if (removedUserIds?.length) {
          await tx.dMParticipant.deleteMany({
            where: { dmChannelId: group.dmChannelId, userId: { in: removedUserIds }, pendingRemoval: { not: null } },
          });
        }
        return { kind: 'ok' as const, commitId: commitRow.id };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.mlsCommit.findUnique({
          where: { groupId_idempotencyKey: { groupId, idempotencyKey } },
          select: { id: true, epoch: true },
        });
        if (existing) return res.json({ epoch: (existing.epoch + 1n).toString(), commitId: existing.id, idempotent: true });
        return res.status(409).json({ error: 'commit_conflict' });
      }
      throw err;
    }

    if (result.kind === 'forbidden') {
      return res.status(403).json({ error: 'Not a participant of this DM channel' });
    }

    if (result.kind === 'forbidden_remove') {
      return res.status(403).json({ error: 'unauthorized_remove' });
    }

    if (result.kind === 'forbidden_add') {
      return res.status(403).json({ error: 'unauthorized_add' });
    }

    if (result.kind === 'conflict') {
      const winner = await prisma.mlsCommit.findUnique({
        where: { groupId_idempotencyKey: { groupId, idempotencyKey } },
        select: { id: true, epoch: true },
      });
      if (winner) return res.json({ epoch: (winner.epoch + 1n).toString(), commitId: winner.id, idempotent: true });
      const fresh = await prisma.mlsGroup.findUnique({ where: { id: groupId }, select: { currentEpoch: true } });
      return res.status(409).json({
        error: 'epoch_conflict',
        currentEpoch: fresh?.currentEpoch?.toString() ?? null,
        recovery: mode === 'external' ? 'refetch_group_info' : 'rebase',
      });
    }

    const newEpoch = N + 1n;
    logger.info({ userId: req.userId, groupId, epoch: newEpoch.toString(), mode }, 'MLS commit accepted');

    // Respond first; the commit is durably committed. Fan-out is BEST-EFFORT (the durable
    // backstop is the GET /commits?sinceEpoch catch-up) so a relay hiccup must
    // never fail an accepted commit. The submitter's OWN user room is no longer excluded — its
    // other devices need the live commit; the submitting device drops its own echo via the
    // client epoch guard. Added recipients get the Welcome notify, not the commit.
    res.json({ epoch: newEpoch.toString(), commitId: result.commitId });

    try {
      const addedRecipientIds = new Set((welcomes ?? []).map((w) => w.recipientId));
      const allParticipants = await prisma.dMParticipant.findMany({
        where: { dmChannelId: group.dmChannelId, pendingRemoval: null },
        select: { userId: true },
        take: 1000,
      });
      const io = req.app.get('io') as import('socket.io').Server | undefined;
      if (io) {
        for (const { userId } of allParticipants) {
          // Per-device identity: no longer suppress the submitter's user
          // room — the submitter's OTHER devices need the live commit. The submitting
          // device drops its own echo via the epoch guard (epoch <= lastAppliedEpoch).
          if (addedRecipientIds.has(userId)) continue; // added members get the Welcome path
          io.to(`user:${userId}`).emit('mls-commit', { groupId, epoch: newEpoch.toString(), commit });
        }
        for (const recipientId of addedRecipientIds) {
          io.to(`user:${recipientId}`).emit('mls-welcome', { groupId, epoch: newEpoch.toString() });
        }
      }
    } catch (relayErr) {
      logger.warn({ err: relayErr, groupId, epoch: newEpoch.toString() }, 'MLS commit fan-out failed; clients recover via catch-up');
    }
    return;
  }),
);

// GET /groups/:groupId/commits?sinceEpoch=N — take-bounded, epoch-ordered catch-up.
// Durable delivery backstop: without it the commit log is write-only and the
// lossy socket relay is the de-facto delivery. Ordered by the epoch integer (never createdAt).
router.get(
  '/groups/:groupId/commits',
  validateUuidParams('groupId'),
  authenticateToken,
  mlsReadLimiter,
  validate(mlsCommitCatchupSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const groupId = req.params.groupId as string;
    const sinceEpoch = BigInt(req.query.sinceEpoch as string);
    const limit = req.query.limit as unknown as number; // coerced by the zod schema

    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId }, select: { dmChannelId: true } });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const participant = await prisma.dMParticipant.findFirst({ where: { dmChannelId: group.dmChannelId, userId: req.userId, pendingRemoval: null }, select: { userId: true } });
    if (!participant) return res.status(403).json({ error: 'Not a participant of this DM channel' });

    const rows = await prisma.mlsCommit.findMany({
      where: { groupId, epoch: { gte: sinceEpoch } },
      orderBy: { epoch: 'asc' }, // canonical order is the epoch integer, never createdAt
      take: limit,
      select: { epoch: true, commitData: true, idempotencyKey: true },
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      commits: rows.map((r) => ({
        baseEpoch: r.epoch.toString(),
        resultingEpoch: (r.epoch + 1n).toString(),
        commit: bufToB64(r.commitData),
        idempotencyKey: r.idempotencyKey,
      })),
    });
  }),
);

// GET /welcomes - recipient-scoped dead-drop pull (take-bounded). Non-destructive;
// post-join consume/delete is the client's job.
router.get(
  '/welcomes',
  authenticateToken,
  mlsReadLimiter,
  validate(mlsWelcomesQuerySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const limit = req.query.limit as unknown as number;
    const rows = await prisma.mlsWelcome.findMany({
      where: { recipientId: req.userId },
      orderBy: { epoch: 'asc' },
      take: limit,
      select: { groupId: true, epoch: true, welcomeData: true },
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      welcomes: rows.map((r) => ({ groupId: r.groupId, epoch: r.epoch.toString(), welcomeData: bufToB64(r.welcomeData) })),
    });
  }),
);

export default router;
