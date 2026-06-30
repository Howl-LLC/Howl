// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { getParam, hasPermission, getEffectivePlan, loadPermissionContext } from '../utils.js';
import { enqueueDiscordImport } from '../queues/producers.js';
import { logger } from '../logger.js';
import { fileURLToPath } from 'node:url';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = logger.child({ module: 'discord-import' });

const router = Router();

// Plan-tier import caps. The multer ceiling is the highest allowed value
// (pro tier); the route handler rejects files above the user's specific
// plan limit. Disk storage keeps the upload off the request-handler heap
// so a Pro user uploading 500 MB doesn't bloat backend RAM.
const MAX_IMPORT_SIZE_MB_BY_PLAN: Record<string, number> = {
  pro: 500,
  essential: 200,
  free: 50,
};
const MAX_IMPORT_SIZE_CEILING = 500 * 1024 * 1024; // absolute ceiling (pro)
// Must match the worker's `uploadsBaseDir = path.resolve(process.cwd(), 'tmp', 'uploads')`
// at backend/src/queues/workers/import.worker.ts so the worker's path-traversal
// guard accepts files written here.
const TMP_DIR = path.resolve(process.cwd(), 'tmp', 'uploads');

const importDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
      cb(null, TMP_DIR);
    } catch (err) {
      cb(err as Error, TMP_DIR);
    }
  },
  filename: (_req, _file, cb) => {
    cb(null, `import-${Date.now()}-${crypto.randomUUID()}.json`);
  },
});
const upload = multer({ storage: importDiskStorage, limits: { fileSize: MAX_IMPORT_SIZE_CEILING } });

function maxImportBytesForPlan(plan: string): number {
  const mb = MAX_IMPORT_SIZE_MB_BY_PLAN[plan] ?? MAX_IMPORT_SIZE_MB_BY_PLAN.free;
  return mb * 1024 * 1024;
}

/** Drop a multer-written temp file. Paths are always inside TMP_DIR (multer's
 *  diskStorage config enforces that), so non-literal fs warnings are not a
 *  concern here — the disable comment is scoped to this helper. */
function unlinkTempFile(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- multer-generated path inside TMP_DIR
    fs.unlinkSync(filePath);
  } catch { /* ignore — file may already be gone */ }
}

// DiscordChatExporter JSON shape

interface DCEMessage {
  id: string;
  type: string;
  timestamp: string;
  timestampEdited: string | null;
  content: string;
  author: {
    id: string;
    name: string;
    discriminator: string;
    nickname: string;
    avatarUrl: string | null;
    isBot: boolean;
  };
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

// POST /api/servers/:serverId/import-discord

const importLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:import:'),
  windowMs: 15 * 60 * 1000,
  max: 2,
  keyGenerator: (req: any) => (req as AuthRequest).userId || getClientIp(req) || 'unknown',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Too many import requests. Please try again later.' },
});

router.post(
  '/:serverId/import-discord',
  authenticateToken,
  importLimiter,
  upload.single('file'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = getParam(req, 'serverId');
      const userId = req.userId!;

      const [ctx, user] = await Promise.all([
        loadPermissionContext(userId, serverId),
        prisma.user.findUnique({
          where: { id: userId },
          select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
        }),
      ]);
      if (!ctx) {
        if (req.file) { unlinkTempFile(req.file.path); }
        return res.status(403).json({ error: 'Not a member of this server' });
      }
      if (!hasPermission(ctx, 'manageServer')) {
        if (req.file) { unlinkTempFile(req.file.path); }
        return res.status(403).json({ error: 'You need the Manage Server permission to import history' });
      }

      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      if (req.file.mimetype !== 'application/json' && !req.file.originalname.endsWith('.json')) {
        unlinkTempFile(req.file.path);
        return res.status(400).json({ error: 'Only JSON files are accepted' });
      }

      // Plan-tier size check. Multer accepts up to the 500 MB ceiling; the
      // actual allowed size depends on the user's plan. Reject cleanly and
      // drop the temp file so the disk doesn't fill with oversized imports.
      const plan = getEffectivePlan(user ?? {});
      const planCap = maxImportBytesForPlan(plan);
      if (req.file.size > planCap) {
        unlinkTempFile(req.file.path);
        const planMB = MAX_IMPORT_SIZE_MB_BY_PLAN[plan] ?? MAX_IMPORT_SIZE_MB_BY_PLAN.free;
        return res.status(413).json({
          error: `File exceeds your plan's import limit of ${planMB} MB.`,
          maxMB: planMB,
          plan,
        });
      }

      let data: DCEExport;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is multer-generated inside TMP_DIR
        const raw = fs.readFileSync(req.file.path, 'utf-8');
        data = JSON.parse(raw);
      } catch {
        unlinkTempFile(req.file.path);
        return res.status(400).json({ error: 'Invalid JSON file' });
      }

      if (
        !data ||
        typeof data !== 'object' ||
        !data.channel?.name ||
        typeof data.channel.name !== 'string' ||
        !Array.isArray(data.messages) ||
        data.messages.length > 100_000
      ) {
        return res.status(400).json({ error: 'Not a valid DiscordChatExporter JSON export or too many messages (max 100k)' });
      }

      // Skip non-text channel exports (voice/stage have no message history)
      const IMPORTABLE_CHANNEL_TYPES = new Set([
        'GuildTextChannel', 'GuildNewsChannel', 'GuildForumChannel',
        'DirectTextChannel', 'DirectGroupTextChannel',
      ]);
      const channelType = data.channel.type ?? 'GuildTextChannel';
      if (!IMPORTABLE_CHANNEL_TYPES.has(channelType)) {
        return res.status(400).json({ error: `Cannot import ${channelType} — only text channels can be imported.` });
      }

      const channelName = data.channel.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').slice(0, 100);

      let channel = await prisma.channel.findFirst({
        where: { serverId, name: channelName },
      });

      let channelCreated = false;
      let categoryCreated = false;
      if (!channel) {
        // Determine which category to place the channel in
        let targetCategory: { id: string; name: string; position: number } | null = null;
        const discordCategoryName = typeof data.channel.category === 'string' ? data.channel.category.trim() : '';

        if (discordCategoryName) {
          const existingCategories = await prisma.channelCategory.findMany({
            where: { serverId },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            take: 200,
          });
          targetCategory = existingCategories.find(
            (c) => c.name.toLowerCase() === discordCategoryName.toLowerCase(),
          ) ?? null;

          if (!targetCategory) {
            const maxCatPos = existingCategories.length > 0
              ? Math.max(...existingCategories.map((c) => c.position))
              : -1;
            const newCat = await prisma.channelCategory.create({
              data: { serverId, name: discordCategoryName.slice(0, 100), position: maxCatPos + 1 },
            });
            targetCategory = newCat;
            categoryCreated = true;
          }
        }

        if (!targetCategory) {
          targetCategory = await prisma.channelCategory.findFirst({
            where: { serverId },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          });
        }
        if (!targetCategory) return res.status(400).json({ error: 'Server has no categories' });

        const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId: targetCategory.id }, _max: { position: true } });
        const position = (maxPos._max.position ?? -1) + 1;
        channel = await prisma.channel.create({
          data: {
            serverId, name: channelName, type: 'text', categoryId: targetCategory.id, position,
            description: (typeof data.channel.topic === 'string' ? data.channel.topic.slice(0, 1024) : `Imported from Discord #${data.channel.name}`).slice(0, 1024),
          },
        });
        channelCreated = true;

        // Notify sidebar about the new channel/category immediately
        const io = req.app.get('io');
        if (io) {
          if (categoryCreated) {
            io.to(`server:${serverId}`).emit('category-created', {
              serverId,
              category: { id: targetCategory.id, name: targetCategory.name, position: targetCategory.position },
            });
          }
          io.to(`server:${serverId}`).emit('channel-created', {
            serverId,
            channel: {
              id: channel.id, name: channel.name,
              description: (channel as any).description ?? undefined,
              type: channel.type, categoryId: (channel as any).categoryId ?? null,
              position: (channel as any).position ?? 0,
            },
          });
        }
      }

      const validMessages = data.messages.filter(
        (m) => m.content || m.attachments?.length > 0,
      );

      // Sanitize imported message fields to prevent stored XSS and enforce length limits
      const sanitizedMessages = validMessages.map((m) => ({
        ...m,
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : '',
        author: {
          ...m.author,
          name: typeof m.author?.name === 'string' ? m.author.name.slice(0, 32) : 'Unknown',
          discriminator: typeof m.author?.discriminator === 'string' ? m.author.discriminator.slice(0, 4) : '0000',
          nickname: typeof m.author?.nickname === 'string' ? m.author.nickname.slice(0, 32) : '',
        },
        attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 20).map((a) => ({
          ...a,
          fileName: typeof a.fileName === 'string' ? a.fileName.slice(0, 255) : 'unknown',
          url: typeof a.url === 'string' ? a.url.slice(0, 2048) : '',
        })) : [],
      }));

      if (sanitizedMessages.length === 0) {
        // Nothing to enqueue — drop the temp file so disk doesn't fill.
        unlinkTempFile(req.file.path);
        return res.json({
          channelName: channel.name,
          channelId: channel.id,
          messagesImported: 0,
          channelCreated,
          categoryCreated,
        });
      }

      // Multer diskStorage already wrote the upload to TMP_DIR, so we hand
      // the worker the file it wrote — no extra copy required. Worker is
      // responsible for deleting after processing.
      const tmpFile = req.file.path;

      const jobId = await enqueueDiscordImport({
        serverId,
        userId,
        channelId: channel.id,
        channelName: channel.name,
        filePath: tmpFile,
      });

      if (jobId) {
        log.info({ jobId, channelName: channel.name, messageCount: sanitizedMessages.length }, 'discord import enqueued');
        return res.status(202).json({
          channelName: channel.name,
          channelId: channel.id,
          jobId,
          status: 'processing',
          messageCount: sanitizedMessages.length,
          channelCreated,
          categoryCreated,
        });
      }

      // Inline fallback removed — processing large imports synchronously in the
      // request handler is a DoS vector. Require the background queue instead.
      unlinkTempFile(req.file?.path);
      return res.status(503).json({ error: 'Import queue is temporarily unavailable. Please try again later.' });
    } catch (err) {
      // On any unexpected failure, drop the temp file so disk doesn't fill.
      unlinkTempFile(req.file?.path);
      next(err);
    }
  },
);

export default router;
