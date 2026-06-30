// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import {
  dmHistoryArchivePostSchema,
  dmHistoryArchivePreviewsSchema,
  dmHistoryArchiveChannelSchema,
  dmHistoryArchiveBulkDeleteSchema,
} from '../schemas.js';
import { getParam } from '../utils.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';

const router = Router();

const PREVIEW_PAGE = 500;
const CHANNEL_PAGE = 200;
// Enforced (not logged) per-user row cap, oldest-first eviction. Overridable
// via env for tests; defaults to the prior high-water value.
const DEFAULT_MAX_ARCHIVE_ROWS_PER_USER = 250_000;
function maxArchiveRowsPerUser(): number {
  return Number(process.env.DM_HISTORY_ARCHIVE_MAX_ROWS) || DEFAULT_MAX_ARCHIVE_ROWS_PER_USER;
}

const historyWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-history-w:'),
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const historyReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-history-r:'),
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Returns the subset of `channelIds` for which `userId` is an ACTIVE
// participant (DMParticipant row with pendingRemoval === null). Used to
// authorize a batch POST in a single query.
async function activeChannelSet(userId: string, channelIds: string[]): Promise<Set<string>> {
  if (channelIds.length === 0) return new Set();
  const rows = await prisma.dMParticipant.findMany({
    where: { userId, dmChannelId: { in: channelIds }, pendingRemoval: null },
    select: { dmChannelId: true },
    take: 50, // mirrors the POST schema items .max(50) cap
  });
  return new Set(rows.map((r) => r.dmChannelId));
}

// True iff `userId` is an ACTIVE participant of `dmChannelId` (pendingRemoval
// === null). A member marked for removal is denied all archive access.
async function isActive(userId: string, dmChannelId: string): Promise<boolean> {
  const row = await prisma.dMParticipant.findFirst({
    where: { userId, dmChannelId, pendingRemoval: null },
    select: { userId: true },
  });
  return row !== null;
}

// POST / — batch upsert (idempotent). Each row is opaque sealed ciphertext;
// the server never reads the plaintext. Unique on
// (userId, dmChannelId, envelopeHash). A re-POST of an identical or
// lower-keyVersion row is a no-op; a higher keyVersion supersedes the stored
// lower-generation row (move-to-Private re-seal).
router.post('/', authenticateToken, historyWriteLimiter, validate(dmHistoryArchivePostSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const items = req.body.items as Array<{
      dmChannelId: string; envelopeHash: string; ciphertext: string;
      keyVersion: number; messageId: string; msgCreatedAt: string;
    }>;
    const distinctIds = [...new Set(items.map((i) => i.dmChannelId))];
    const active = await activeChannelSet(req.userId, distinctIds);
    if (active.size !== distinctIds.length) return res.status(403).json({ error: 'Not in this DM' });

    const userId = req.userId;
    const cap = maxArchiveRowsPerUser();
    const { stored, evicted } = await prisma.$transaction(async (tx) => {
      // Drop items whose (dmChannelId, messageId) was deleted-for-everyone.
      // SERIALIZABLE so the tombstone-filter SELECT and the per-item inserts are
      // serialized against a concurrent DELETE that commits the tombstone in between —
      // under READ COMMITTED that interleaving would resurrect a deleted message (the
      // archive unique is on envelopeHash, not messageId, so a late tombstone can't
      // block the insert). On a serialization conflict the request fails and the client retries.
      const tomb = await tx.dmHistoryArchiveTombstone.findMany({
        where: { userId, OR: items.map((i) => ({ dmChannelId: i.dmChannelId, messageId: i.messageId })) },
        select: { dmChannelId: true, messageId: true },
      });
      const tombSet = new Set(tomb.map((t) => `${t.dmChannelId}:${t.messageId}`));
      const allowed = items.filter((i) => !tombSet.has(`${i.dmChannelId}:${i.messageId}`));

      // move-to-Private keyVersion FLOOR + higher-keyVersion SUPERSEDE,
      // composed with the tombstone filter above and run on `tx` so it is
      // inside the SERIALIZABLE envelope. A higher keyVersion must supersede a stored
      // lower one for the same (userId, dmChannelId, envelopeHash): the move-to-Private
      // re-seal uploads keyVersion=2 rows after bulk-deleting the keyVersion=1 archive;
      // a late keyVersion=1 POST after that DELETE must NOT leave the server holding
      // DM-history plaintext sealed under the escrow-exposed old key. ONE atomic
      // statement per item does BOTH the floor check and the insert-or-conditionally-
      // supersede, so neither is a stale check-then-act; the floor subquery is read in
      // the same statement (and SERIALIZABLE tx) as the insert, closing the
      // read-then-insert TOCTOU. $executeRaw returns 1 on insert OR supersede, 0 when
      // below the floor / a no-op re-POST / a stale lower POST. (id is TEXT with no DB
      // default so we supply a uuid; createdAt defaults to CURRENT_TIMESTAMP; all
      // unique-key columns are plain TEXT, so no ::uuid casts.)
      const created = { count: 0 };
      for (const i of allowed) {
        created.count += await tx.$executeRaw`
          INSERT INTO "DmHistoryArchive"
            ("id", "userId", "dmChannelId", "envelopeHash", "ciphertext", "keyVersion", "messageId", "msgCreatedAt")
          SELECT ${randomUUID()}, ${userId}, ${i.dmChannelId}, ${i.envelopeHash}, ${i.ciphertext}, ${i.keyVersion}, ${i.messageId}, ${new Date(i.msgCreatedAt)}
          WHERE ${i.keyVersion} >= COALESCE((SELECT "minArchiveKeyVersion" FROM "SecureKeyBundle" WHERE "userId" = ${userId}), 1)
          ON CONFLICT ("userId", "dmChannelId", "envelopeHash")
          DO UPDATE SET
            "ciphertext" = EXCLUDED."ciphertext",
            "keyVersion" = EXCLUDED."keyVersion",
            "messageId" = EXCLUDED."messageId",
            "msgCreatedAt" = EXCLUDED."msgCreatedAt"
          WHERE EXCLUDED."keyVersion" > "DmHistoryArchive"."keyVersion"
        `;
      }

      // Enforce the per-user cap, oldest-first. Counted+evicted inside the
      // SERIALIZABLE tx so concurrent same-user POSTs cannot under-count and overshoot
      // the ceiling (a transient overshoot would otherwise self-correct on the next POST).
      let evictedCount = 0;
      if (created.count > 0) {
        const total = await tx.dmHistoryArchive.count({ where: { userId } });
        if (total > cap) {
          const oldest = await tx.dmHistoryArchive.findMany({
            where: { userId },
            orderBy: [{ msgCreatedAt: 'asc' }, { id: 'asc' }],
            take: total - cap,
            select: { id: true },
          });
          const del = await tx.dmHistoryArchive.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
          evictedCount = del.count;
        }
      }
      return { stored: created.count, evicted: evictedCount };
    }, { isolationLevel: 'Serializable' });

    if (evicted > 0) logger.warn({ userId, evicted, cap }, 'dm history archive cap enforced (oldest-first eviction)');
    res.json({ stored, evicted });
  }),
);

// GET /previews — latest row per active-participant channel. DISTINCT ON keeps
// only the newest (msgCreatedAt DESC) row per dmChannelId; cursor paginates by
// dmChannelId. NOTE: declared BEFORE /:dmChannelId so Express does not capture
// "previews" as a UUID param.
router.get('/previews', authenticateToken, historyReadLimiter, validate(dmHistoryArchivePreviewsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const cursor = req.query.cursor as string | undefined;
    const rows = await prisma.$queryRaw<Array<{
      dmChannelId: string; messageId: string; envelopeHash: string;
      ciphertext: string; keyVersion: number; msgCreatedAt: Date;
    }>>(Prisma.sql`
      SELECT DISTINCT ON (a."dmChannelId")
        a."dmChannelId", a."messageId", a."envelopeHash", a."ciphertext", a."keyVersion", a."msgCreatedAt"
      FROM "DmHistoryArchive" a
      WHERE a."userId" = ${req.userId}
        AND EXISTS (
          SELECT 1 FROM "DMParticipant" p
          WHERE p."dmChannelId" = a."dmChannelId" AND p."userId" = ${req.userId} AND p."pendingRemoval" IS NULL
        )
        ${cursor ? Prisma.sql`AND a."dmChannelId" > ${cursor}` : Prisma.empty}
      ORDER BY a."dmChannelId", a."msgCreatedAt" DESC
      LIMIT ${PREVIEW_PAGE + 1}
    `);
    const hasMore = rows.length > PREVIEW_PAGE;
    const page = hasMore ? rows.slice(0, PREVIEW_PAGE) : rows;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      rows: page.map((r) => ({ ...r, msgCreatedAt: r.msgCreatedAt.toISOString() })),
      nextCursor: hasMore ? page[page.length - 1].dmChannelId : null,
    });
  }),
);

// GET /:dmChannelId — paginated full restore, newest-first. Cursor is the last
// row id from the previous page.
router.get('/:dmChannelId', validateUuidParams('dmChannelId'), authenticateToken, historyReadLimiter,
  validate(dmHistoryArchiveChannelSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    if (!(await isActive(req.userId, dmChannelId))) return res.status(403).json({ error: 'Not in this DM' });
    const cursorId = req.query.cursor as string | undefined;
    const rows = await prisma.dmHistoryArchive.findMany({
      where: { userId: req.userId, dmChannelId },
      orderBy: [{ msgCreatedAt: 'desc' }, { id: 'desc' }],
      take: CHANNEL_PAGE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: { id: true, dmChannelId: true, messageId: true, envelopeHash: true, ciphertext: true, keyVersion: true, msgCreatedAt: true },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      rows: rows.map((r) => ({ ...r, msgCreatedAt: r.msgCreatedAt.toISOString() })),
      nextCursor: rows.length === CHANNEL_PAGE ? rows[rows.length - 1].id : null,
    });
  }),
);

// DELETE /:dmChannelId/:messageId — delete-for-everyone write-through. Removes
// every archived revision sharing the messageId (original + edits). Idempotent.
router.delete('/:dmChannelId/:messageId', validateUuidParams('dmChannelId', 'messageId'),
  authenticateToken, historyWriteLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const messageId = getParam(req, 'messageId');
    if (!(await isActive(req.userId, dmChannelId))) return res.status(403).json({ error: 'Not in this DM' });
    const userId = req.userId;
    // Delete the rows AND record a write-once tombstone in ONE tx, so a
    // re-POST of the same messageId can never resurrect it (the POST filters tombstoned
    // items). SERIALIZABLE so this tombstone write and a concurrent POST's tombstone
    // SELECT are serialized — both txs must be SERIALIZABLE for Postgres SSI to detect
    // the read/write conflict. Tombstone is per-user (the archive itself is per-user).
    const result = await prisma.$transaction(async (tx) => {
      const del = await tx.dmHistoryArchive.deleteMany({ where: { userId, dmChannelId, messageId } });
      await tx.dmHistoryArchiveTombstone.upsert({
        where: { userId_dmChannelId_messageId: { userId, dmChannelId, messageId } },
        create: { userId, dmChannelId, messageId },
        update: {}, // write-once: never overwrite an existing tombstone
      });
      return del;
    }, { isolationLevel: 'Serializable' });
    res.json({ deleted: result.count });
  }),
);

// DELETE / - bulk wipe of the caller's entire archive (move-to-Private re-seal).
// Scoped to req.userId. An optional keyVersion raises the per-user
// minArchiveKeyVersion high-water mark (GREATEST, never lowered) so a stale
// sibling tab cannot re-upload rows sealed under the old escrow-exposed
// archiveKey after the rotation, regardless of that tab's state. The bump and
// the wipe run in one transaction so the floor is in place before/with the
// delete.
router.delete('/', authenticateToken, historyWriteLimiter, validate(dmHistoryArchiveBulkDeleteSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const userId = req.userId;
    const keyVersion = req.query.keyVersion as number | undefined;
    const result = await prisma.$transaction(async (tx) => {
      if (typeof keyVersion === 'number') {
        await tx.dmKeyBundle.updateMany({
          where: { userId, minArchiveKeyVersion: { lt: keyVersion } },
          data: { minArchiveKeyVersion: keyVersion },
        });
      }
      return tx.dmHistoryArchive.deleteMany({ where: { userId } });
    });
    res.json({ deleted: result.count });
  }),
);

export default router;
