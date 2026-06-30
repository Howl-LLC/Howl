// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { createServerFolderSchema, updateServerFolderSchema, reorderServerFoldersSchema, importServerFoldersSchema } from '../schemas.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();
const MAX_FOLDERS = 20;

const folderReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:folder-read:'),
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const folderMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:folder-mutate:'),
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Load all server folders for a user. Shared with the /bootstrap aggregate
 * endpoint so cold-start clients can fetch folders in one round trip.
 */
export async function loadUserServerFolders(userId: string): Promise<unknown[]> {
  return prisma.serverFolder.findMany({
    where: { userId },
    orderBy: { position: 'asc' },
    take: MAX_FOLDERS,
  });
}

// GET /api/server-folders — list all folders for the authenticated user
router.get('/', authenticateToken, folderReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const folders = await loadUserServerFolders(req.userId);
  res.json(folders);
}));

// POST /api/server-folders — create a new folder
router.post('/', authenticateToken, folderMutateLimiter, validate(createServerFolderSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const count = await prisma.serverFolder.count({ where: { userId: req.userId } });
  if (count >= MAX_FOLDERS) {
    return res.status(400).json({ error: `Maximum of ${MAX_FOLDERS} folders reached.` });
  }
  const { name, color, serverIds } = req.body;

  // Atomic: dedup serverIds from other folders + create — all or nothing
  const folder = await prisma.$transaction(async (tx) => {
    if (serverIds.length > 0) {
      const existing = await tx.serverFolder.findMany({
        where: { userId: req.userId, serverIds: { hasSome: serverIds } },
        select: { id: true, serverIds: true },
        take: MAX_FOLDERS,
      });
      for (const f of existing) {
        const filtered = f.serverIds.filter((id: string) => !serverIds.includes(id));
        await tx.serverFolder.update({ where: { id: f.id }, data: { serverIds: filtered } });
      }
    }
    return tx.serverFolder.create({
      data: {
        userId: req.userId!,
        name,
        color: color ?? null,
        serverIds,
        position: count,
      },
    });
  });
  res.status(201).json(folder);
}));

// POST /api/server-folders/import — bulk import from localStorage migration (one-time)
router.post('/import', authenticateToken, folderMutateLimiter, validate(importServerFoldersSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.serverFolder.count({ where: { userId: req.userId } });
  if (existing > 0) {
    return res.status(409).json({ error: 'Folders already exist. Import skipped.' });
  }
  const { folders } = req.body;
  if (folders.length === 0) return res.json([]);

  const created = await prisma.$transaction(
    folders.slice(0, MAX_FOLDERS).map((f: { name: string; color?: string; serverIds: string[]; muted: boolean }, i: number) =>
      prisma.serverFolder.create({
        data: {
          userId: req.userId!,
          name: f.name,
          color: f.color ?? null,
          serverIds: f.serverIds,
          position: i,
          muted: f.muted,
        },
      })
    )
  );
  res.status(201).json(created);
}));

// PUT /api/server-folders/reorder — batch reorder positions
router.put('/reorder', authenticateToken, folderMutateLimiter, validate(reorderServerFoldersSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { folderIds } = req.body;
  const folders = await prisma.serverFolder.findMany({
    where: { userId: req.userId },
    select: { id: true },
    take: MAX_FOLDERS,
  });
  const ownedIds = new Set(folders.map((f) => f.id));
  for (const id of folderIds) {
    if (!ownedIds.has(id)) {
      return res.status(403).json({ error: 'Folder not found.' });
    }
  }
  await prisma.$transaction(
    folderIds.map((id: string, i: number) =>
      prisma.serverFolder.update({ where: { id }, data: { position: i } })
    )
  );
  res.json({ success: true });
}));

// PATCH /api/server-folders/:folderId — update a folder
router.patch('/:folderId', authenticateToken, folderMutateLimiter, validateUuidParams('folderId'), validate(updateServerFolderSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const folderId = req.params!.folderId as string;
  const folder = await prisma.serverFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== req.userId) {
    return res.status(404).json({ error: 'Folder not found.' });
  }

  const { name, color, serverIds, muted } = req.body;
  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (color !== undefined) data.color = color;
  if (muted !== undefined) data.muted = muted;
  if (serverIds !== undefined) data.serverIds = serverIds;

  // Atomic: dedup serverIds from other folders + update — all or nothing
  const updated = await prisma.$transaction(async (tx) => {
    if (serverIds !== undefined && serverIds.length > 0) {
      const others = await tx.serverFolder.findMany({
        where: { userId: req.userId, id: { not: folder.id }, serverIds: { hasSome: serverIds } },
        select: { id: true, serverIds: true },
        take: MAX_FOLDERS,
      });
      for (const f of others) {
        const filtered = f.serverIds.filter((id: string) => !serverIds.includes(id));
        await tx.serverFolder.update({ where: { id: f.id }, data: { serverIds: filtered } });
      }
    }
    return tx.serverFolder.update({ where: { id: folder.id }, data });
  });
  res.json(updated);
}));

// DELETE /api/server-folders/:folderId — delete a folder
router.delete('/:folderId', authenticateToken, folderMutateLimiter, validateUuidParams('folderId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const folderId = req.params!.folderId as string;
  const folder = await prisma.serverFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== req.userId) {
    return res.status(404).json({ error: 'Folder not found.' });
  }
  await prisma.serverFolder.delete({ where: { id: folder.id } });
  res.json({ success: true });
}));

export default router;
