// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discord import worker.
 *
 * Processes large DiscordChatExporter JSON files in the background,
 * batch-inserting messages and resolving reply references.
 *
 * Job data:
 *   { serverId, userId, channelId, channelName, jsonBuffer: string (base64) }
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { Prisma } from '../../../generated/prisma-client-v7/client.js';
import { logger } from '../../logger.js';
import { importJobSchema } from '../workerSchemas.js';
import type { Server as IOServer } from 'socket.io';

const log = logger.child({ module: 'worker:import' });

let _io: IOServer | null = null;

/** Must be called once at startup so the worker can emit Socket.IO events. */
export function setImportIO(io: IOServer): void {
  _io = io;
}

interface DCEMessage {
  id: string;
  type: string;
  timestamp: string;
  timestampEdited: string | null;
  content: string;
  author: { id: string; name: string; discriminator: string; nickname: string; avatarUrl: string | null; isBot: boolean };
  attachments: { id: string; url: string; fileName: string; fileSizeBytes: number }[];
  reactions: { emoji: { id: string | null; name: string }; count: number }[];
  reference?: { messageId: string; channelId?: string; guildId?: string };
}

interface DCEExport {
  guild: { id: string; name: string; iconUrl?: string };
  channel: { id: string; type: string; categoryId?: string; category?: string; name: string; topic?: string };
  messages: DCEMessage[];
  messageCount: number;
}

export interface ImportJobData {
  serverId: string;
  userId: string;
  channelId: string;
  channelName: string;
  filePath: string;
}

// eslint-disable-next-line no-misleading-character-class -- intentional Unicode control/BiDi ranges
const CONTROL_CHAR_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u180E\uFFF9-\uFFFB]/g;
const MAX_IMPORT_MSG_LENGTH = 4000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Strip control/BiDi chars and escape HTML entities from an untrusted Discord export field. */
function sanitizeField(s: string, maxLen: number): string {
  return escapeHtml(s.replace(CONTROL_CHAR_RE, '')).slice(0, maxLen);
}

const BATCH_SIZE = 500;

async function processImport(job: Job<ImportJobData>) {
  const parsed = importJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid import job payload');
    return { messagesImported: 0 };
  }
  const { serverId: _serverId, userId, channelId, channelName, filePath } = parsed.data;
  const fsp = await import('fs/promises');
  const pathMod = await import('path');
  const uploadsBaseDir = pathMod.resolve(process.cwd(), 'tmp', 'uploads');
  const safeFilePath = pathMod.resolve(filePath);
  if (!safeFilePath.startsWith(pathMod.resolve(uploadsBaseDir) + pathMod.sep) && safeFilePath !== pathMod.resolve(uploadsBaseDir)) {
    log.error({ filePath }, 'path traversal attempt detected in import file path');
    return { messagesImported: 0 };
  }
  // Matches the route-level pro-tier ceiling. The route already rejects
  // files above the user's specific plan limit (50 / 200 / 500 MB) before
  // enqueueing, so this is a secondary safety net, not the primary gate.
  const MAX_IMPORT_SIZE = 500 * 1024 * 1024;
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    log.error({ filePath }, 'import file not found');
    return { messagesImported: 0 };
  }
  if (stat.size > MAX_IMPORT_SIZE) {
    throw new Error(`Import file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_IMPORT_SIZE / 1024 / 1024}MB)`);
  }
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch {
    log.error({ filePath }, 'failed to read import file');
    return { messagesImported: 0 };
  }
  const data: DCEExport = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) {
    throw new Error('Invalid import file format: expected { messages: [...] }');
  }
  // NOTE: the file was previously unlinked here, BEFORE processing. That
  // broke retries — attempt 2 failed with "file not found" and the job
  // dead-lettered silently. Unlink is now deferred to the successful-exit
  // path below (and to the `failed` handler on permanent failure).

  const validMessages = data.messages.filter((m) => m.content || m.attachments?.length > 0);
  if (validMessages.length === 0) {
    log.info({ jobId: job.id, channelName }, 'no messages to import');
    try { await fsp.unlink(filePath); } catch { /* best-effort cleanup */ }
    return { messagesImported: 0 };
  }

  const discordIdToHowlId = new Map<string, string>();
  let totalImported = 0;
  const startTime = Date.now();
  log.info({ jobId: job.id, channelName, totalMessages: validMessages.length }, 'discord import starting');

  for (let i = 0; i < validMessages.length; i += BATCH_SIZE) {
    const batch = validMessages.slice(i, i + BATCH_SIZE);
    const rows = batch.map((m) => {
      const id = crypto.randomUUID();
      discordIdToHowlId.set(m.id, id);

      let content = m.content || '';
      if (m.attachments?.length > 0) {
        const safeAttachments = m.attachments.filter((a) => {
          try { return new URL(a.url).protocol === 'https:'; }
          catch { return false; }
        });
        const links = safeAttachments.map((a) => `[${sanitizeField(a.fileName, 256)}](${a.url})`).join('\n');
        content = content ? `${content}\n${links}` : links;
      }

      // Sanitize imported content: strip BiDi/control chars and enforce length limit
      content = content.replace(CONTROL_CHAR_RE, '').slice(0, MAX_IMPORT_MSG_LENGTH);

      const safeAvatar = (() => {
        try { return new URL(m.author.avatarUrl || '').protocol === 'https:' ? m.author.avatarUrl : null; }
        catch { return null; }
      })();

      return {
        id,
        channelId,
        authorId: userId,
        content,
        type: 'imported' as const,
        systemPayload: {
          discordAuthor: sanitizeField(m.author.name, 32),
          discordAuthorAvatar: safeAvatar,
          discordAuthorId: sanitizeField(m.author.id, 24),
          discordMessageId: sanitizeField(m.id, 24),
          discordReplyTo: m.reference?.messageId ? sanitizeField(m.reference.messageId, 24) : null,
        },
        createdAt: new Date(m.timestamp),
        editedAt: m.timestampEdited ? new Date(m.timestampEdited) : null,
      };
    });

    await prisma.message.createMany({ data: rows });
    totalImported += rows.length;

    await job.updateProgress(Math.round((i + batch.length) / validMessages.length * 100));
    // Per-5k progress log so operators can tell from logs whether a long-
    // running job is making progress vs. stuck.
    if (totalImported % 5000 === 0 || i + batch.length >= validMessages.length) {
      log.info({ jobId: job.id, processed: totalImported, total: validMessages.length, elapsedMs: Date.now() - startTime }, 'discord import progress');
    }
  }

  // Resolve reply references in bulk. Previously this was N individual
  // `prisma.message.update()` calls — for a channel with 30k replies
  // that meant 30k separate DB round-trips (~30 minutes). One
  // `UPDATE ... FROM (VALUES ...)` per 1000-row chunk replaces that.
  const replyUpdates: { id: string; replyToMessageId: string }[] = [];
  for (const m of validMessages) {
    if (m.reference?.messageId) {
      const howlId = discordIdToHowlId.get(m.id);
      const replyTarget = discordIdToHowlId.get(m.reference.messageId);
      if (howlId && replyTarget) {
        replyUpdates.push({ id: howlId, replyToMessageId: replyTarget });
      }
    }
  }

  if (replyUpdates.length > 0) {
    const REPLY_BATCH = 1000;
    for (let i = 0; i < replyUpdates.length; i += REPLY_BATCH) {
      const batch = replyUpdates.slice(i, i + REPLY_BATCH);
      const pairs = Prisma.join(
        batch.map(u => Prisma.sql`(${u.id}::uuid, ${u.replyToMessageId}::uuid)`),
        ', '
      );
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "Message" AS m
        SET "replyToMessageId" = v.ref
        FROM (VALUES ${pairs}) AS v("id", "ref")
        WHERE m.id = v.id
      `);
    }
    log.info({ jobId: job.id, replies: replyUpdates.length, elapsedMs: Date.now() - startTime }, 'discord import replies resolved');
  }

  // Notify the server room that import is complete
  if (_io) {
    _io.to(`server:${parsed.data.serverId}`).emit('server-import-complete', {
      serverId: parsed.data.serverId,
      channelId,
      channelName,
      messagesImported: totalImported,
    });
  }

  // Work done — safe to delete the source file now (after all attempts
  // could possibly need it).
  try { await fsp.unlink(filePath); } catch { /* best-effort cleanup */ }

  log.info({ jobId: job.id, channelName, totalImported, replies: replyUpdates.length, elapsedMs: Date.now() - startTime }, 'discord import complete');
  return { messagesImported: totalImported };
}

export function startImportWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;
  const worker = new Worker('discord-import', processImport, {
    connection: redisConnection,
    concurrency: 2,
    // 2 hours. A 100k-message / 200 MB+ import with bulk reply updates
    // still runs 10-30 minutes on a slow DB. Previous 10-minute lock
    // caused BullMQ to declare the lock stale mid-run, kicking off a
    // second concurrent worker on the same file — or worse, a retry on
    // a file the first worker had already unlinked.
    lockDuration: 2 * 60 * 60 * 1000,
  });
  worker.on('failed', async (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // Import job.data can contain attachment URLs and other user-sourced
      // content; keep only the IDs needed to correlate with the triggering
      // request.
      log.error({ jobId: job.id, err, serverId: job.data?.serverId, userId: job.data?.userId, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: import job permanently failed after all retries');
      // Surface the failure to the UI so the spinner stops with a real
      // message. Without this, a dead-lettered job leaves the user
      // staring at "Importing..." forever.
      if (_io && job.data?.serverId) {
        _io.to(`server:${job.data.serverId}`).emit('server-import-failed', {
          serverId: job.data.serverId,
          error: err?.message || 'Import failed',
        });
      }
      // Clean up the upload file on permanent failure — retries won't
      // happen, and we don't want the disk to fill with failed imports.
      if (job.data?.filePath) {
        try {
          const fsp = await import('fs/promises');
          await fsp.unlink(job.data.filePath);
        } catch { /* best-effort */ }
      }
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'import job failed (will retry)');
    }
  });
  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'import job completed'));
  log.info('discord-import worker started');
  return worker;
}
