// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Scheduled data cleanup worker.
 *
 * Runs periodic maintenance tasks:
 *   - Purge expired invites
 *   - Clean up expired email verification codes
 *   - Clean up expired password reset codes
 *   - Clean up stale sessions
 *   - Purge old audit logs per server retention setting
 *   - Enforce per-server message retention policies
 *   - Detect and remove orphan attachments (uploaded but never referenced)
 *   - Remove stale push subscriptions
 *   - Delete expired data export files (14-day retention)
 */

import { Worker, Job } from 'bullmq';
import type { Server as IOServer } from 'socket.io';
import { redisConnection, queuesEnabled } from '../connection.js';
import { EXPORTS_DIR } from '../../exportsDir.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { cleanupJobSchema } from '../workerSchemas.js';
import { electOldestRemaining } from '../../routes/dms.js';
import {
  redis, isUserConnected,
  findUserVoiceChannel, removeVoiceParticipant, setVoiceReverseLookup,
  deleteVoiceOverride, getVoiceParticipants,
} from '../../redis.js';
import { removeLiveKitParticipant } from '../../services/livekitAdmin.js';
import { scheduleVoiceE2eeRotate } from '../../services/voiceE2eeRotation.js';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
import type { PDQ as PDQType } from 'pdq-wasm';

const log = logger.child({ module: 'worker:cleanup' });

let _io: IOServer | null = null;

/** Must be called once at startup so the worker can broadcast member-removed
 *  events when the periodic sweep evicts expired temporary members. */
export function setCleanupIO(io: IOServer): void {
  _io = io;
}

// Atomic compare-and-delete for the cross-replica orphan-cleanup lock.
// Registered via ioredis.defineCommand so the Lua script ships once and
// each release is a single round-trip. Without compare-and-delete a slow
// worker whose TTL expired could accidentally release a fresh lock owned
// by a different replica.
if (redis && typeof (redis as { defineCommand?: unknown }).defineCommand === 'function') {
  (redis as unknown as { defineCommand: (name: string, def: { numberOfKeys: number; lua: string }) => void }).defineCommand('releaseIfOwner', {
    numberOfKeys: 1,
    lua: 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '..', '..', '..', 'uploads');

import { getS3Client, S3_BUCKET, S3_PREFIX, s3Enabled } from '../../services/s3.js';
const s3 = getS3Client();

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const ORPHAN_AGE_HOURS = 72; // files older than this with no DB reference are orphans
// Why 72h (was 24h): the previous 24h window left no slack for the
// upload-then-commit-row race. A DM attachment uploads, the client encrypts and
// commits the DMMessage row a few seconds later — but if the client backgrounds
// for ~24h before committing, the orphan sweeper deletes the file out from
// under it. Three days of headroom eliminates that whole class of false-orphan.
const MAX_REFERENCED_FILES = 500_000; // Safety limit to prevent OOM during orphan scan

// Hard ceiling on R2 deletions per run. Catches the failure shape that
// the per-page (>50%) and hard-floor (<10 references) guards can miss:
// a partial scan failure on a large bucket where each page only loses a
// minority of references, but the absolute deletion count balloons.
//
// A healthy run on this codebase deletes 0–10 files; a partial-scan failure
// can over-delete far more. A cap of 500 leaves headroom for legitimate
// backlog cleanup (e.g., after retiring a feature) while ensuring any
// runaway deletion stops well short of catastrophic data loss.
//
// If a legitimate cleanup needs more, raise this constant in a deploy,
// run once, then revert. Don't add an env-var override — the friction is
// the point.
const MAX_S3_DELETIONS_PER_RUN = 500;

export interface CleanupJobData {
  task: 'expiredInvites' | 'expiredVerifyCodes' | 'expiredResetCodes' | 'staleSessions' | 'staleAdminSessions' | 'auditLogs' | 'messageRetention' | 'orphanAttachments' | 'stalePushSubs' | 'expiredExports' | 'expiredPowerUps' | 'expiredPlans' | 'expiredTrialSetups' | 'imageHashes' | 'imageHashSweep' | 'expiredGiftSubs' | 'stalePresence' | 'expiredTrustedDevices' | 'expiredLoginVerifications' | 'sessionPii' | 'expiredTemporaryMembers' | 'mlsStalePendingRemoval' | 'mlsRetentionSweep' | 'lightweight' | 'all';
}

// Lazy-loaded PDQ instance for the retroactive sweep. The upload route owns
// the production PDQ binding; we instantiate a separate one here so the sweep
// works whether it runs in the same process (BullMQ inline) or a dedicated
// worker process (future). PDQ.init is idempotent so calling it twice is fine.
const __require = createRequire(import.meta.url);
const { PDQ } = __require('pdq-wasm') as { PDQ: typeof PDQType };
let pdqReadyPromise: Promise<boolean> | null = null;
function ensurePdqReady(): Promise<boolean> {
  if (!pdqReadyPromise) {
    pdqReadyPromise = PDQ.init()
      .then(() => true)
      .catch(err => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'cleanup worker: PDQ.init failed');
        return false;
      });
  }
  return pdqReadyPromise;
}

async function purgeExpiredInvites(): Promise<number> {
  const result = await prisma.invite.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
  return result.count;
}

/** Remove members whose originating temporary-invite snapshot has elapsed,
 *  unless they've since been assigned a role. Emits `server-member-left` for
 *  each removal so connected clients prune the row in real time. Paginated
 *  to keep individual deletes bounded; loops until the working set is empty.
 *
 *  TOCTOU note: the per-row `deleteMany` re-asserts the original predicate
 *  (`roleId: null` + `temporaryExpiresAt: lt now`) so a race-winner — e.g. a
 *  moderator granting a role between the find and delete, or extending the
 *  temporaryExpiresAt — is preserved instead of being silently overwritten.
 *  Per-row keeps the emit list honest: we only fan out `server-member-left`
 *  for rows the database actually deleted. */
export async function purgeExpiredTemporaryMembers(): Promise<number> {
  const now = new Date();
  let total = 0;
  for (let page = 0; page < 20; page++) {
    const expired = await prisma.serverMember.findMany({
      where: { temporaryExpiresAt: { not: null, lt: now }, roleId: null },
      select: { userId: true, serverId: true },
      take: 500,
    });
    if (expired.length === 0) break;
    const deleted: { userId: string; serverId: string }[] = [];
    for (const m of expired) {
      const result = await prisma.serverMember.deleteMany({
        where: {
          userId: m.userId,
          serverId: m.serverId,
          roleId: null,
          temporaryExpiresAt: { not: null, lt: now },
        },
      });
      if (result.count > 0) deleted.push(m);
    }
    if (_io) {
      for (const m of deleted) {
        _io.to(`server:${m.serverId}`).emit('server-member-left', { userId: m.userId, serverId: m.serverId });
        // A purged temporary member may still be sitting in a server voice
        // channel when their membership expires. This is an INVOLUNTARY removal
        // with other members remaining (same class as a kick), so mirror the
        // kick path: drop them from the SFU and rotate the SFrame key so their
        // retained key no longer protects the remaining members' media.
        const voiceChannelId = await findUserVoiceChannel(m.userId);
        if (voiceChannelId) {
          const ch = await prisma.channel.findUnique({ where: { id: voiceChannelId }, select: { serverId: true } }).catch(() => null);
          if (ch?.serverId === m.serverId) {
            await removeVoiceParticipant(voiceChannelId, m.userId);
            await setVoiceReverseLookup(m.userId, null);
            await deleteVoiceOverride(voiceChannelId, m.userId);
            _io.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId: m.userId });
            const remaining = await getVoiceParticipants(voiceChannelId);
            _io.to(`server:${m.serverId}`).emit('server-voice-participants', { serverId: m.serverId, channelId: voiceChannelId, participants: remaining });
            scheduleVoiceE2eeRotate(_io, voiceChannelId, remaining.length > 0);
            removeLiveKitParticipant(`voice:${voiceChannelId}`, m.userId).catch(() => {});
          }
        }
      }
    }
    total += deleted.length;
    if (expired.length < 500) break;
  }
  return total;
}

async function purgeExpiredVerifyCodes(): Promise<number> {
  const result = await prisma.user.updateMany({
    where: { emailVerifyExpiry: { not: null, lt: new Date() } },
    data: { emailVerifyCode: null, emailVerifyExpiry: null },
  });
  return result.count;
}

async function purgeExpiredResetCodes(): Promise<number> {
  const result = await prisma.user.updateMany({
    where: { passwordResetExpiry: { not: null, lt: new Date() } },
    data: { passwordResetCode: null, passwordResetExpiry: null },
  });
  return result.count;
}

/** Delete TrustedDevice rows past their 90-day sliding expiry — lets the
 *  user be re-challenged next time they log in from that browser. */
async function purgeExpiredTrustedDevices(): Promise<number> {
  const result = await prisma.trustedDevice.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/** Delete LoginVerification rows that are past their 10-minute TTL or
 *  already consumed more than 24h ago (kept briefly for audit). */
async function purgeExpiredLoginVerifications(): Promise<number> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.loginVerification.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { consumedAt: { not: null, lt: dayAgo } },
      ],
    },
  });
  return result.count;
}

async function purgeStaleSessions(): Promise<number> {
  // Must be >= REFRESH_COOKIE_MAX_AGE_MS from authHelpers.ts (90 days). If
  // the cleanup threshold is shorter, this worker deletes session rows while
  // refresh cookies are still valid on clients. Then the 30-minute socket
  // revalidation timer in socketHandlers/connection.ts sees no session row
  // and emits 'session-expired', booting the user to the login screen
  // despite them being within the sliding refresh window. Matching the two
  // windows prevents that footgun. Browser sessions also hit a 365-day
  // absolute cap in auth.ts at /refresh time; Electron desktop sessions
  // stay alive as long as they're actively refreshed.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const result = await prisma.session.deleteMany({
    where: { lastActiveAt: { lt: ninetyDaysAgo } },
  });
  return result.count;
}

async function purgeAuditLogs(): Promise<number> {
  let total = 0;

  // Per-server audit log retention
  const settings = await prisma.serverSettings.findMany({
    select: { serverId: true, auditLogRetentionDays: true },
  });

  const settingsByRetention = new Map<number, string[]>();
  for (const s of settings) {
    const days = s.auditLogRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
    if (days <= 0) continue;
    if (!settingsByRetention.has(days)) settingsByRetention.set(days, []);
    settingsByRetention.get(days)!.push(s.serverId);
  }
  const batchResults = await Promise.all(
    Array.from(settingsByRetention.entries()).map(([days, serverIds]) => {
      const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
      return prisma.auditLog.deleteMany({ where: { serverId: { in: serverIds }, createdAt: { lt: cutoff } } });
    }),
  );
  for (const r of batchResults) total += r.count;

  // Servers without explicit settings get the default
  const serverIdsWithSettings = settings.map(s => s.serverId);
  const defaultCutoff = new Date(Date.now() - DEFAULT_AUDIT_RETENTION_DAYS * 24 * 3600 * 1000);
  const defaultResult = await prisma.auditLog.deleteMany({
    where: {
      serverId: { notIn: serverIdsWithSettings },
      createdAt: { lt: defaultCutoff },
    },
  });
  total += defaultResult.count;

  // Admin audit logs: always 90-day retention
  const adminResult = await prisma.adminAuditLog.deleteMany({
    where: { createdAt: { lt: defaultCutoff } },
  });
  total += adminResult.count;

  return total;
}

async function enforceMessageRetention(): Promise<number> {
  let total = 0;

  const settings = await prisma.serverSettings.findMany({
    where: { messageRetentionDays: { not: null } },
    select: { serverId: true, messageRetentionDays: true },
  });

  for (const s of settings) {
    if (!s.messageRetentionDays || s.messageRetentionDays <= 0) continue;
    const cutoff = new Date(Date.now() - s.messageRetentionDays * 24 * 3600 * 1000);

    const channels = await prisma.channel.findMany({
      where: { serverId: s.serverId },
      select: { id: true },
    });
    const channelIds = channels.map(c => c.id);
    if (channelIds.length === 0) continue;

    // Delete old messages in batches of 5000 to avoid lock contention and statement_timeout
    let batchDeleted: number;
    do {
      batchDeleted = await prisma.$executeRaw`
        DELETE FROM "Message"
        WHERE id IN (
          SELECT id FROM "Message"
          WHERE "channelId" = ANY(${channelIds}::text[])
            AND "createdAt" < ${cutoff}
            AND "type" = 'message'
          LIMIT 5000
        )
      `;
      total += batchDeleted;
    } while (batchDeleted > 0);
  }

  return total;
}

async function purgeOrphanAttachments(): Promise<number> {
  // Cross-replica mutex. BullMQ's lockDuration is 5 min; if a slow run gets
  // re-issued by the stalled-checker the original worker may still be
  // executing — a likely contributor to false-orphan over-deletion when
  // passes overlap during a deploy. This Redis lock guarantees
  // only one cleanup pass runs across all replicas regardless of BullMQ
  // state. TTL is generous (1h) so a hung worker eventually frees the lock.
  const lockKey = 'lock:cleanup:orphanAttachments';
  const lockToken = randomUUID();
  const lockTtlMs = 60 * 60 * 1000;
  if (redis) {
    const acquired = await redis.set(lockKey, lockToken, 'PX', lockTtlMs, 'NX');
    if (!acquired) {
      log.warn({ lockKey }, 'orphan cleanup: another instance holds the lock, skipping run');
      return 0;
    }
  }

  try {
    return await purgeOrphanAttachmentsInner();
  } finally {
    if (redis) {
      const releaseFn = (redis as unknown as { releaseIfOwner?: (key: string, token: string) => Promise<number> }).releaseIfOwner;
      if (releaseFn) {
        await releaseFn.call(redis, lockKey, lockToken).catch((err) => {
          log.warn({ err }, 'orphan cleanup: lock release failed (will expire via TTL)');
        });
      }
    }
  }
}

async function purgeOrphanAttachmentsInner(): Promise<number> {
  let total = 0;
  const cutoff = new Date(Date.now() - ORPHAN_AGE_HOURS * 3600 * 1000);
  const batchSize = 5000;

  // Collect all attachment URLs referenced by messages (paginated)
  const referencedFiles = new Set<string>();

  // Paginate Message attachments
  let cursor: string | undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; attachmentUrl: string | null }[] = await prisma.message.findMany({
      where: { attachmentUrl: { not: null } },
      select: { id: true, attachmentUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const m of batch) {
      if (m.attachmentUrl) {
        const filename = m.attachmentUrl.split('/').pop();
        if (filename) referencedFiles.add(filename);
      }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate DMMessage attachments
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; attachmentUrl: string | null }[] = await prisma.dMMessage.findMany({
      where: { attachmentUrl: { not: null } },
      select: { id: true, attachmentUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const m of batch) {
      if (m.attachmentUrl) {
        const filename = m.attachmentUrl.split('/').pop();
        if (filename) referencedFiles.add(filename);
      }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate User avatars/banners/backgroundImages
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; avatar: string | null; banner: string | null; backgroundImage: string | null }[] = await prisma.user.findMany({
      select: { id: true, avatar: true, banner: true, backgroundImage: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const u of batch) {
      if (u.avatar) { const f = u.avatar.split('/').pop(); if (f) referencedFiles.add(f); }
      if (u.banner) { const f = u.banner.split('/').pop(); if (f) referencedFiles.add(f); }
      if (u.backgroundImage) { const f = u.backgroundImage.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate Server icons/banners
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; icon: string | null; banner: string | null }[] = await prisma.server.findMany({
      select: { id: true, icon: true, banner: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const s of batch) {
      if (s.icon) { const f = s.icon.split('/').pop(); if (f) referencedFiles.add(f); }
      if (s.banner) { const f = s.banner.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate CustomEmoji imageUrls
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; imageUrl: string }[] = await prisma.customEmoji.findMany({
      select: { id: true, imageUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const e of batch) {
      const f = e.imageUrl.split('/').pop();
      if (f) referencedFiles.add(f);
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate Sticker imageUrls
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; imageUrl: string }[] = await prisma.sticker.findMany({
      select: { id: true, imageUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const st of batch) {
      const f = st.imageUrl.split('/').pop();
      if (f) referencedFiles.add(f);
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate SoundboardSound audio files
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; audioUrl: string }[] = await prisma.soundboardSound.findMany({
      select: { id: true, audioUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const s of batch) {
      const f = s.audioUrl.split('/').pop();
      if (f) referencedFiles.add(f);
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate ForumPost imageUrls (post cover images)
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; imageUrl: string | null }[] = await prisma.forumPost.findMany({
      where: { imageUrl: { not: null } },
      select: { id: true, imageUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const p of batch) {
      if (p.imageUrl) { const f = p.imageUrl.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate ForumMessage attachmentUrls
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; attachmentUrl: string | null }[] = await prisma.forumMessage.findMany({
      where: { attachmentUrl: { not: null } },
      select: { id: true, attachmentUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const m of batch) {
      if (m.attachmentUrl) { const f = m.attachmentUrl.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate ThreadMessage attachmentUrls
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; attachmentUrl: string | null }[] = await prisma.threadMessage.findMany({
      where: { attachmentUrl: { not: null } },
      select: { id: true, attachmentUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const m of batch) {
      if (m.attachmentUrl) { const f = m.attachmentUrl.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate ServerMember per-server avatars/banners. Composite PK
  // (userId, serverId) — order by both for stable pagination.
  let memberCursor: { userId: string; serverId: string } | undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { userId: string; serverId: string; serverAvatar: string | null; serverBanner: string | null }[] = await prisma.serverMember.findMany({
      where: { OR: [{ serverAvatar: { not: null } }, { serverBanner: { not: null } }] },
      select: { userId: true, serverId: true, serverAvatar: true, serverBanner: true },
      take: batchSize,
      ...(memberCursor ? { skip: 1, cursor: { userId_serverId: memberCursor } } : {}),
      orderBy: [{ userId: 'asc' }, { serverId: 'asc' }],
    });
    for (const m of batch) {
      if (m.serverAvatar) { const f = m.serverAvatar.split('/').pop(); if (f) referencedFiles.add(f); }
      if (m.serverBanner) { const f = m.serverBanner.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    memberCursor = { userId: batch[batch.length - 1].userId, serverId: batch[batch.length - 1].serverId };
  }

  // Paginate ServerRole icons.
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; icon: string | null }[] = await prisma.serverRole.findMany({
      where: { icon: { not: null } },
      select: { id: true, icon: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const r of batch) {
      if (r.icon) { const f = r.icon.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate DMChannel group icons.
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; icon: string | null }[] = await prisma.dMChannel.findMany({
      where: { icon: { not: null } },
      select: { id: true, icon: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const ch of batch) {
      if (ch.icon) { const f = ch.icon.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Paginate ServerSettings.bannerSplash (community-server preview banner).
  // Cursor is the composite-table PK `serverId`.
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { serverId: string; bannerSplash: string | null }[] = await prisma.serverSettings.findMany({
      where: { bannerSplash: { not: null } },
      select: { serverId: true, bannerSplash: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { serverId: cursor } } : {}),
      orderBy: { serverId: 'asc' },
    });
    for (const s of batch) {
      if (s.bannerSplash) { const f = s.bannerSplash.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].serverId;
  }

  // Paginate MessageReport.attachmentUrl. CSAM auto-flagged uploads land
  // here as the *sole* persisted reference once the upload route blocks the
  // post — without this scan the moderator-evidence file is swept on the
  // next 72h cron and the report becomes meaningless.
  cursor = undefined;
  while (true) {
    if (referencedFiles.size >= MAX_REFERENCED_FILES) {
      log.warn({ size: referencedFiles.size }, 'orphan cleanup: referenced file set too large, aborting to prevent OOM');
      return 0;
    }
    const batch: { id: string; attachmentUrl: string | null }[] = await prisma.messageReport.findMany({
      where: { attachmentUrl: { not: null } },
      select: { id: true, attachmentUrl: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    for (const r of batch) {
      if (r.attachmentUrl) { const f = r.attachmentUrl.split('/').pop(); if (f) referencedFiles.add(f); }
    }
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }

  // Purge local disk orphans (async to avoid blocking the event loop)
  try {
    await fsp.access(UPLOADS_DIR);
    const files = await fsp.readdir(UPLOADS_DIR);
    const resolvedUploadsDir = path.resolve(UPLOADS_DIR);
    for (const file of files) {
      if (referencedFiles.has(file)) continue;
      const filePath = path.join(UPLOADS_DIR, file);
      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(resolvedUploadsDir + path.sep)) {
        log.warn({ file }, 'path traversal attempt in cleanup, skipping');
        continue;
      }
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const stat = await fsp.lstat(filePath);
        if (stat.isSymbolicLink()) {
          log.warn({ file }, 'symlink found in uploads dir, removing link only');
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          await fsp.unlink(filePath);
          total++;
          continue;
        }
        if (stat.mtimeMs < cutoff.getTime()) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          await fsp.unlink(filePath);
          total++;
        }
      } catch {
        // best effort — file may have been deleted concurrently
      }
    }
  } catch (err) {
    // UPLOADS_DIR doesn't exist or readdir failed
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'orphan attachment scan (local) failed');
    }
  }

  // Purge S3 orphans.
  //
  // Defense in depth: if the referenced-files scan returns suspiciously few
  // rows (e.g. a Prisma error swallowed silently mid-pagination), every R2
  // object would look orphan and the worker would nuke the bucket. A scan
  // that fails to enumerate every attachment-bearing column would mass-delete
  // referenced files. The hard floor + per-pass ratio
  // guards below prevent that class of failure from ever deleting again.
  if (s3Enabled && s3) {
    if (referencedFiles.size < 10) {
      log.error({ referencedSize: referencedFiles.size }, 'orphan cleanup: referenced set too small — refusing to run S3 purge (likely scan failure)');
      return total;
    }
    try {
      let continuationToken: string | undefined;
      let listedThisRun = 0;
      let candidatesThisRun = 0;
      let s3DeletionCount = 0;
      do {
        const listResult = await s3.send(new ListObjectsV2Command({
          Bucket: S3_BUCKET,
          Prefix: S3_PREFIX,
          ContinuationToken: continuationToken,
          MaxKeys: 500,
        }));

        const toDelete: { Key: string }[] = [];
        for (const obj of listResult.Contents ?? []) {
          if (!obj.Key || !obj.LastModified) continue;
          listedThisRun++;
          const filename = obj.Key.replace(S3_PREFIX, '');
          if (referencedFiles.has(filename)) continue;
          if (obj.LastModified.getTime() >= cutoff.getTime()) continue;

          toDelete.push({ Key: obj.Key });
          candidatesThisRun++;
        }

        // Per-page kill switch: if a single page would delete > 50% of the
        // page, something is wrong upstream — abort before we cascade. A
        // healthy bucket has nearly all objects referenced.
        if (toDelete.length > 0 && toDelete.length > (listResult.Contents?.length ?? 0) / 2) {
          log.error({
            referencedSize: referencedFiles.size,
            pageSize: listResult.Contents?.length ?? 0,
            wouldDelete: toDelete.length,
          }, 'orphan cleanup: per-page deletion ratio > 50% — aborting S3 purge (likely scan failure)');
          return total;
        }

        // Batch delete up to 1000 objects per request
        for (let i = 0; i < toDelete.length; i += 1000) {
          const batch = toDelete.slice(i, i + 1000);
          // Per-run absolute cap. If this batch would push us over,
          // abort cleanly — return whatever we've already deleted so the
          // job result is honest. Operators can investigate, then either
          // raise MAX_S3_DELETIONS_PER_RUN for a one-off legitimate
          // backlog or fix the upstream bug if the references are wrong.
          if (s3DeletionCount + batch.length > MAX_S3_DELETIONS_PER_RUN) {
            log.error({
              alreadyDeleted: s3DeletionCount,
              wouldAdd: batch.length,
              cap: MAX_S3_DELETIONS_PER_RUN,
              referencedSize: referencedFiles.size,
              listedThisRun,
              candidatesThisRun,
            }, 'orphan cleanup: per-run S3 deletion cap exceeded — aborting (raise MAX_S3_DELETIONS_PER_RUN if legitimate)');
            return total;
          }
          await s3.send(new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: batch, Quiet: true },
          }));
          total += batch.length;
          s3DeletionCount += batch.length;
        }

        continuationToken = listResult.NextContinuationToken;
      } while (continuationToken);
      log.info({ listedThisRun, candidatesThisRun, referencedSize: referencedFiles.size }, 'orphan cleanup: S3 purge complete');
    } catch (err) {
      log.warn({ err }, 'orphan attachment scan (S3) failed');
    }
  }

  return total;
}

async function purgeStalePushSubscriptions(): Promise<number> {
  // Remove push subscriptions older than 90 days (likely expired/revoked)
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const result = await prisma.pushSubscription.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}

async function purgeExpiredExports(): Promise<number> {
  const exportsDir = EXPORTS_DIR;
  const expired = await prisma.dataExportRequest.findMany({
    where: { status: 'ready', expiresAt: { not: null, lt: new Date() } },
    select: { id: true, filePath: true },
  });

  for (const req of expired) {
    if (req.filePath) {
      const safePath = path.resolve(req.filePath);
      if (!safePath.startsWith(path.resolve(exportsDir) + path.sep)) {
        log.warn({ requestId: req.id, filePath: req.filePath }, 'skipping export file outside exports dir');
        continue;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path validated against exportsDir above
      try { fs.unlinkSync(safePath); } catch { /* file may already be gone */ }
    }
  }

  if (expired.length > 0) {
    await prisma.dataExportRequest.updateMany({
      where: { id: { in: expired.map(e => e.id) } },
      data: { status: 'expired', filePath: null, downloadToken: '' },
    });
  }

  return expired.length;
}

async function expireAdminGrantedPowerUps(): Promise<number> {
  const now = new Date();
  const result = await prisma.server.updateMany({
    where: {
      powerUpStatus: 'active',
      powerUpPeriodEnd: { not: null, lt: now },
    },
    data: { powerUpCount: 0, powerUpStatus: null, powerUpPeriodEnd: null },
  });
  return result.count;
}

async function expireAdminGrantedPlans(): Promise<number> {
  const now = new Date();
  const result = await prisma.user.updateMany({
    where: {
      stripeStatus: 'active',
      stripePeriodEnd: { not: null, lt: now },
      stripeSubscriptionId: null,
    },
    data: { stripePlan: null, stripeStatus: null, stripePeriodEnd: null },
  });
  return result.count;
}

async function purgeExpiredTrialSetups(): Promise<number> {
  const result = await prisma.pendingTrialSetup.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/**
 * Compare every ImageHash row (where flagMatch=false) against the current
 * FlaggedHash list. When a row matches, set flagMatch=true on every row
 * sharing the same filename (so multi-frame uploads get fully marked) and
 * create a single MessageReport per filename.
 *
 * Used when an admin adds a new flagged hash and wants past uploads
 * scanned. Idempotent — re-running the sweep doesn't create duplicate
 * reports because (a) flagMatch=true rows are excluded by the where clause
 * and (b) we dedup-check MessageReport by `messageId = filename` before
 * inserting.
 */
export async function sweepImageHashes(): Promise<{ scanned: number; matched: number; reported: number }> {
  const lockKey = 'lock:cleanup:imageHashSweep';
  const lockToken = randomUUID();
  const lockTtlMs = 60 * 60 * 1000;
  if (redis) {
    const acquired = await redis.set(lockKey, lockToken, 'PX', lockTtlMs, 'NX');
    if (!acquired) {
      log.warn({ lockKey }, 'image hash sweep: another instance holds the lock, skipping run');
      return { scanned: 0, matched: 0, reported: 0 };
    }
  }

  try {
    const pdqOk = await ensurePdqReady();
    if (!pdqOk) {
      log.error('image hash sweep: PDQ not ready, skipping');
      return { scanned: 0, matched: 0, reported: 0 };
    }

    // Mirror upload.ts/getFlaggedHashes: only manual (snapshotId=null) + active
    // snapshot rows count as the live matching set. Aborted/staging rows must
    // not retroactively flag historic uploads.
    const flaggedRows = await prisma.flaggedHash.findMany({
      where: { OR: [{ snapshotId: null }, { snapshot: { isActive: true } }] },
      select: { hash: true },
    });
    if (flaggedRows.length === 0) {
      log.info('image hash sweep: no flagged hashes — nothing to do');
      return { scanned: 0, matched: 0, reported: 0 };
    }
    const flaggedBytes: Uint8Array[] = [];
    for (const row of flaggedRows) {
      try { flaggedBytes.push(PDQ.fromHex(row.hash)); } catch { /* skip malformed flagged entry */ }
    }
    if (flaggedBytes.length === 0) {
      log.warn({ flaggedCount: flaggedRows.length }, 'image hash sweep: every flagged hash failed to decode, aborting');
      return { scanned: 0, matched: 0, reported: 0 };
    }

    let scanned = 0;
    let matched = 0;
    let reported = 0;
    const reportedFilenames = new Set<string>();
    let cursor: string | undefined;
    const batchSize = 1000;

    while (true) {
      // Only PDQ-hashable rows participate in this sweep. Non-image uploads
      // (video, audio, PDF, zip) get an ImageHash row with hash=null + sha256
      // populated for NCMEC exact-match capture, but they have no perceptual
      // hash to compare against the PDQ flagged list.
      const batch = await prisma.imageHash.findMany({
        where: { flagMatch: false, hash: { not: null } },
        select: { id: true, hash: true, sha256: true, uploaderId: true, filename: true },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        scanned++;
        if (!row.hash) continue; // belt-and-suspenders; the WHERE filters these out
        let candidateBytes: Uint8Array;
        try {
          candidateBytes = PDQ.fromHex(row.hash);
        } catch {
          continue; // skip malformed row
        }
        const isMatch = flaggedBytes.some(fb => PDQ.areSimilar(candidateBytes, fb, 31));
        if (!isMatch) continue;

        matched++;
        // Mark every frame row for this filename so a future sweep doesn't
        // re-scan its siblings. updateMany on a non-existent set is a no-op.
        await prisma.imageHash.updateMany({
          where: { filename: row.filename },
          data: { flagMatch: true },
        });

        if (reportedFilenames.has(row.filename)) continue;
        reportedFilenames.add(row.filename);
        const existing = await prisma.messageReport.findFirst({
          where: { messageId: row.filename, reason: 'csam' },
          select: { id: true },
        });
        if (!existing) {
          // Snapshot the uploader's identity at sweep time. The user may have
          // since deleted their account (the author FK is SetNull) — in
          // which case authorId resolves to null but the lookup also returns
          // null and we just record what we have. PDQ hash + sha256 + filename
          // + attachmentUrl is still enough to act on.
          const authorSnapshot = await prisma.user.findUnique({
            where: { id: row.uploaderId },
            select: { username: true, discriminator: true, emailHash: true, createdAt: true },
          }).catch(() => null);
          // No request context — uploaderIp/UA aren't available retroactively.
          // Operators can pull historic IP from Session.rawIp where the
          // session window overlaps the upload (within 90 days).
          try {
            await prisma.messageReport.create({
              data: {
                reporterId: null,
                messageType: 'channel',
                messageId: row.filename,
                authorId: authorSnapshot ? row.uploaderId : null,
                authorUsernameSnapshot: authorSnapshot?.username ?? null,
                authorDiscriminatorSnapshot: authorSnapshot?.discriminator ?? null,
                authorEmailHashSnapshot: authorSnapshot?.emailHash ?? null,
                authorRegisteredAtSnapshot: authorSnapshot?.createdAt ?? null,
                sha256: row.sha256,
                preservedAt: new Date(),
                content: '[auto-flagged upload, retroactive sweep]',
                attachmentUrl: `/api/uploads/${row.filename}`,
                reason: 'csam',
                details: `PDQ hash match: ${row.hash} (retroactive sweep)`,
                contentSource: 'server',
                status: 'pending',
              },
            });
            reported++;
          } catch (reportErr) {
            log.error({ err: reportErr, filename: row.filename }, 'sweep: failed to create retroactive auto-report');
          }
        }
      }

      if (batch.length < batchSize) break;
      cursor = batch[batch.length - 1].id;
    }

    log.info({ scanned, matched, reported, flaggedCount: flaggedBytes.length }, 'image hash sweep complete');
    return { scanned, matched, reported };
  } finally {
    if (redis) {
      const releaseFn = (redis as unknown as { releaseIfOwner?: (key: string, token: string) => Promise<number> }).releaseIfOwner;
      if (releaseFn) {
        await releaseFn.call(redis, lockKey, lockToken).catch((err) => {
          log.warn({ err }, 'image hash sweep: lock release failed (will expire via TTL)');
        });
      }
    }
  }
}

/**
 * Null out Session.rawIp and Session.userAgent on rows that have been idle
 * for more than 90 days. The session row itself is purged separately by
 * `purgeStaleSessions` (which uses lastActiveAt < 90d) — but we want the PII
 * gone *before* the row hits that 90-day threshold in case any session is
 * extended past it (rolling refresh windows). Running this on the daily
 * lightweight cron means the worst-case window is "90 days + 24h."
 *
 * The hashed `ip` column is left untouched: it's used for new-device
 * detection and isn't itself sensitive (truncated SHA-256). Only the raw
 * fields decay.
 */
async function purgeStaleSessionPii(): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const result = await prisma.session.updateMany({
    where: {
      lastActiveAt: { lt: cutoff },
      OR: [{ rawIp: { not: null } }, { userAgent: { not: null } }],
    },
    data: { rawIp: null, userAgent: null },
  });
  return result.count;
}

async function purgeOldImageHashes(): Promise<number> {
  // Retain image hashes for 180 days (6 months) for safety auditing
  // Flagged matches are retained indefinitely for legal compliance
  const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000);
  const result = await prisma.imageHash.deleteMany({
    where: { flagMatch: false, createdAt: { lt: cutoff } },
  });
  return result.count;
}

async function purgeStaleAdminSessions(): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const result = await prisma.adminSession.deleteMany({
    where: { lastActiveAt: { lt: thirtyDaysAgo } },
  });
  return result.count;
}

// MLS persistence retention
// Nothing else prunes these. MlsKeyPackage.consume only tombstones consumedAt
// (the pool cap counts AVAILABLE rows only), and MlsWelcome has no consume/delete
// route and no FK on groupId (the DMChannel->MlsGroup delete cascade never reaches
// it), so consumed/expired KeyPackages and stale/orphaned Welcomes accumulate
// without bound. These reapers bound that growth in code (reaper-only; no schema
// migration / FK).
const KP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // grace past consumedAt/notAfter
const WELCOME_TTL_MS = 14 * 24 * 60 * 60 * 1000;  // undelivered Welcome delivery TTL

/**
 * Prune consumed (tombstoned) and naturally-expired KeyPackages older than the
 * grace window. NEVER deletes last-resort packages (reusable, never tombstoned —
 * `isLastResort:false` ANDs with both OR branches). Expired/consumed rows are
 * already invisible to reads (every read filters notAfter>now + consumedAt:null),
 * so this only bounds the dead-row backlog — and it finally exercises
 * @@index([notAfter]) for pruning. Returns the deleted count.
 */
export async function sweepExpiredKeyPackages(): Promise<number> {
  const cutoff = new Date(Date.now() - KP_RETENTION_MS);
  // Batch the delete in 5000-row chunks (mirrors enforceMessageRetention) so the
  // FIRST run against the never-before-pruned backlog stays under the pool's 10s
  // statement_timeout (db.ts) instead of timing out + retrying + dead-lettering.
  let total = 0;
  let batch: number;
  do {
    batch = await prisma.$executeRaw`
      DELETE FROM "MlsKeyPackage"
      WHERE id IN (
        SELECT id FROM "MlsKeyPackage"
        WHERE "isLastResort" = false
          AND ("consumedAt" < ${cutoff} OR "notAfter" < ${cutoff})
        LIMIT 5000
      )`;
    total += batch;
  } while (batch > 0);
  return total;
}

/**
 * Prune stale and orphaned Welcomes. (A) TTL: an undelivered Welcome older than
 * the delivery TTL is stale — the recipient device re-bootstraps via External
 * Commit against the latest GroupInfo. (B) Orphans: because MlsWelcome.groupId
 * has no FK, a Welcome survives its group's deletion; drop rows whose groupId no
 * longer resolves to a live MlsGroup. Resolution is groupId-ONLY (epoch is the
 * joiner's target, legitimately ahead of the group's currentEpoch during
 * catch-up, so an epoch comparison would wrongly delete valid pending Welcomes).
 * Returns the per-predicate deleted counts.
 */
export async function sweepStaleWelcomes(): Promise<{ byTtl: number; orphaned: number }> {
  const ttlCutoff = new Date(Date.now() - WELCOME_TTL_MS);
  // Both deletes are batched in 5000-row chunks so the first run against the
  // never-before-pruned backlog cannot exceed the pool's 10s statement_timeout
  // (db.ts) and wedge the reaper on the very table it exists to bound. Prisma's
  // deleteMany cannot express NOT EXISTS / LIMIT, so these use parameterized
  // tagged-template $executeRaw (safe binding, no string interpolation).
  let byTtl = 0;
  let ttlBatch: number;
  do {
    ttlBatch = await prisma.$executeRaw`
      DELETE FROM "MlsWelcome"
      WHERE id IN (SELECT id FROM "MlsWelcome" WHERE "createdAt" < ${ttlCutoff} LIMIT 5000)`;
    byTtl += ttlBatch;
  } while (ttlBatch > 0);
  let orphaned = 0;
  let orphanBatch: number;
  do {
    orphanBatch = await prisma.$executeRaw`
      DELETE FROM "MlsWelcome"
      WHERE id IN (
        SELECT w.id FROM "MlsWelcome" w
        WHERE NOT EXISTS (SELECT 1 FROM "MlsGroup" g WHERE g."id" = w."groupId")
        LIMIT 5000
      )`;
    orphaned += orphanBatch;
  } while (orphanBatch > 0);
  return { byTtl, orphaned };
}

async function purgeExpiredGiftSubscriptions(): Promise<number> {
  const expired = await prisma.giftSubscription.deleteMany({
    where: { status: 'pending', expiresAt: { not: null, lt: new Date() } },
  });
  // Cancel stale payment_pending gifts (25h — gives Stripe's expired webhook time to fire first)
  const stale = await prisma.giftSubscription.updateMany({
    where: {
      status: 'payment_pending',
      createdAt: { lt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    },
    data: { status: 'cancelled' },
  });
  if (stale.count > 0) {
    log.info({ count: stale.count }, 'Cancelled stale payment_pending gift subscriptions');
  }
  return expired.count + stale.count;
}

/**
 * Defense-in-depth: an owner-authorized Remove sets
 * DMParticipant.pendingRemoval, but the actual cryptographic eviction only
 * lands once an elected remaining member submits an MLS Remove commit. If that
 * committer is offline, the Remove may never land — leaving the leaver a live
 * MLS leaf still holding the epoch secrets. For each group channel with a
 * pendingRemoval older than olderThanMs and a live MLS group, re-fire the
 * EXISTING `dm-key-rotation-needed` trigger to the elected remaining member so
 * the Remove commit is re-attempted. This NEVER deletes the participant row —
 * only the accepted Remove commit's finalize does that — so it is idempotent
 * (once removed, the row is gone and the sweep skips it). Returns the number of
 * stuck channels handled. Bounded: take 200 stuck rows per run.
 *
 * The sweep IS presence-aware: it checks cross-replica socket presence via
 * `isUserConnected` (Redis-backed) for each remaining member and prefers an
 * online committer. When no remaining member is currently online,
 * electOldestRemaining falls back to the absolute oldest and the next sweep
 * cycle re-fires once a remaining member reconnects.
 */
export async function sweepStalePendingRemovals(
  io: IOServer,
  olderThanMs: number,
  isConnected: (userId: string) => Promise<boolean> = isUserConnected,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stuck = await prisma.dMParticipant.findMany({
    where: { pendingRemoval: { lt: cutoff }, dmChannel: { isGroup: true, mlsGroups: { some: {} } } },
    select: { userId: true, dmChannelId: true },
    take: 200,
  });
  let handled = 0;
  for (const { userId: leaverId, dmChannelId } of stuck) {
    const participants = await prisma.dMParticipant.findMany({
      where: { dmChannelId },
      select: { userId: true, joinedAt: true, pendingRemoval: true },
    });
    const realRemaining = participants
      .filter((p) => p.userId !== leaverId && p.pendingRemoval === null)
      .map((p) => p.userId);
    // Prefer an ONLINE committer (cross-replica presence). If none are online,
    // electOldestRemaining falls back to the absolute oldest and the next sweep
    // cycle re-fires once that member reconnects.
    const connectedUserIds = new Set<string>();
    const flags = await Promise.all(
      realRemaining.map((uid) => isConnected(uid).then((c) => [uid, c] as const)),
    );
    for (const [uid, c] of flags) if (c) connectedUserIds.add(uid);
    const election = electOldestRemaining(participants, leaverId, connectedUserIds);
    if (!election) continue; // no real member remains to author the Remove
    for (const uid of election.memberIds) {
      io.to(`user:${uid}`).emit('dm-key-rotation-needed', {
        dmChannelId,
        oldestMemberId: election.oldestMemberId,
        memberIds: election.memberIds,
        leaverId,
      });
    }
    handled += 1;
  }
  return handled;
}

async function cleanStalePresence(): Promise<number> {
  if (!redis) return 0;
  let fixed = 0;
  const BATCH = 500;
  let skip = 0;
  while (true) {
    const onlineUsers = await prisma.user.findMany({
      where: { status: { in: ['online', 'idle', 'dnd'] } },
      select: { id: true },
      take: BATCH,
      skip,
      orderBy: { id: 'asc' },
    });
    if (onlineUsers.length === 0) break;

    // Pipeline all SCARD checks in one Redis round-trip
    const pipeline = redis.pipeline();
    for (const u of onlineUsers) {
      pipeline.scard(`sockets:${u.id}`);
    }
    const results = await pipeline.exec();

    // Collect user IDs with zero active sockets
    const staleIds: string[] = [];
    if (results) {
      for (let i = 0; i < onlineUsers.length; i++) {
        const [err, count] = results[i] ?? [null, 0];
        if (!err && (count as number) === 0) {
          staleIds.push(onlineUsers[i].id);
        }
      }
    }

    // Batch update all stale users at once
    if (staleIds.length > 0) {
      const r = await prisma.user.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'offline' },
      });
      fixed += r.count;
    }

    if (onlineUsers.length < BATCH) break;
    skip += BATCH;
  }
  return fixed;
}

async function processCleanup(job: Job<CleanupJobData>) {
  const parsed = cleanupJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid cleanup job payload');
    return;
  }
  const { task } = parsed.data;
  const results: Record<string, number> = {};

  // Lightweight group: all quick DB cleanup tasks (no heavy scans)
  if (task === 'lightweight' || task === 'all') {
    results.expiredInvites = await purgeExpiredInvites();
    results.expiredVerifyCodes = await purgeExpiredVerifyCodes();
    results.expiredResetCodes = await purgeExpiredResetCodes();
    results.staleSessions = await purgeStaleSessions();
    results.staleAdminSessions = await purgeStaleAdminSessions();
    results.auditLogs = await purgeAuditLogs();
    results.stalePushSubs = await purgeStalePushSubscriptions();
    results.expiredExports = await purgeExpiredExports();
    results.expiredPowerUps = await expireAdminGrantedPowerUps();
    results.expiredPlans = await expireAdminGrantedPlans();
    results.expiredTrialSetups = await purgeExpiredTrialSetups();
    results.imageHashes = await purgeOldImageHashes();
    results.expiredGiftSubs = await purgeExpiredGiftSubscriptions();
    results.expiredTrustedDevices = await purgeExpiredTrustedDevices();
    results.expiredLoginVerifications = await purgeExpiredLoginVerifications();
    results.sessionPii = await purgeStaleSessionPii();
    results.expiredTemporaryMembers = await purgeExpiredTemporaryMembers();
  }

  // Individual task handlers — for standalone scheduling and manual triggers
  if (task === 'expiredInvites') {
    results.expiredInvites = await purgeExpiredInvites();
  }
  if (task === 'expiredVerifyCodes') {
    results.expiredVerifyCodes = await purgeExpiredVerifyCodes();
  }
  if (task === 'expiredResetCodes') {
    results.expiredResetCodes = await purgeExpiredResetCodes();
  }
  if (task === 'staleSessions') {
    results.staleSessions = await purgeStaleSessions();
  }
  if (task === 'auditLogs') {
    results.auditLogs = await purgeAuditLogs();
  }
  if (task === 'messageRetention' || task === 'all') {
    results.messageRetention = await enforceMessageRetention();
  }
  if (task === 'orphanAttachments' || task === 'all') {
    results.orphanAttachments = await purgeOrphanAttachments();
  }
  if (task === 'stalePushSubs') {
    results.stalePushSubs = await purgeStalePushSubscriptions();
  }
  if (task === 'expiredExports') {
    results.expiredExports = await purgeExpiredExports();
  }
  if (task === 'expiredPowerUps') {
    results.expiredPowerUps = await expireAdminGrantedPowerUps();
  }
  if (task === 'expiredPlans') {
    results.expiredPlans = await expireAdminGrantedPlans();
  }
  if (task === 'expiredTrialSetups') {
    results.expiredTrialSetups = await purgeExpiredTrialSetups();
  }
  if (task === 'imageHashes') {
    results.imageHashes = await purgeOldImageHashes();
  }
  if (task === 'imageHashSweep') {
    const sweepResult = await sweepImageHashes();
    results.imageHashSweepScanned = sweepResult.scanned;
    results.imageHashSweepMatched = sweepResult.matched;
    results.imageHashSweepReported = sweepResult.reported;
  }
  if (task === 'expiredGiftSubs') {
    results.expiredGiftSubs = await purgeExpiredGiftSubscriptions();
  }
  if (task === 'staleAdminSessions') {
    results.staleAdminSessions = await purgeStaleAdminSessions();
  }
  if (task === 'stalePresence' || task === 'all') {
    results.stalePresence = await cleanStalePresence().catch(() => 0);
  }
  if (task === 'expiredTrustedDevices') {
    results.expiredTrustedDevices = await purgeExpiredTrustedDevices();
  }
  if (task === 'expiredLoginVerifications') {
    results.expiredLoginVerifications = await purgeExpiredLoginVerifications();
  }
  if (task === 'sessionPii') {
    results.sessionPii = await purgeStaleSessionPii();
  }
  if (task === 'expiredTemporaryMembers') {
    results.expiredTemporaryMembers = await purgeExpiredTemporaryMembers();
  }
  if (task === 'mlsStalePendingRemoval') {
    // Re-fires the Remove trigger for stuck pendingRemoval rows (one-hour
    // threshold). No-op when no io is set — without a socket server we can't
    // deliver the rotation signal, so nothing to do.
    results.mlsStalePendingRemoval = _io
      ? await sweepStalePendingRemovals(_io, 60 * 60 * 1000)
      : 0;
  }
  if (task === 'mlsRetentionSweep') {
    // Bound MLS persistence growth: prune consumed/expired KeyPackages
    // and stale/orphaned Welcomes. Pure deletes, no _io needed.
    results.mlsKeyPackagesReaped = await sweepExpiredKeyPackages();
    const welcomes = await sweepStaleWelcomes();
    results.mlsWelcomesReapedByTtl = welcomes.byTtl;
    results.mlsWelcomesReapedOrphaned = welcomes.orphaned;
  }

  log.info({ jobId: job.id, task, results }, 'cleanup complete');
  return results;
}

export function startCleanupWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;
  const worker = new Worker('cleanup', processCleanup, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 300_000,
  });
  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // Omit job.data; cleanup jobs occasionally carry email or session
      // identifiers. Keep the job type only for triage.
      log.error({ jobId: job.id, err, type: (job.data as { type?: string } | undefined)?.type, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: cleanup job permanently failed after all retries');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'cleanup job failed (will retry)');
    }
  });
  log.info('cleanup worker started');
  return worker;
}
