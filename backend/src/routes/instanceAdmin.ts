// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createInstanceUserSchema, resetInstanceUserPasswordSchema } from '../schemas.js';
import { encryptSecret, hashEmail } from '../services/mfaCrypto.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';
import { isSelfHost } from '../selfHost.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'instanceAdmin' });
const router = Router();
const BCRYPT_ROUNDS = 12;

// Dedicated Redis-backed limiter for the instance-admin write surface. Both
// routes do bcrypt(12) + (reset) session deletion, so cap independently of the
// global limiter. Keyed by the authed admin userId, falling back to client IP.
const instanceAdminWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:instance-admin:'),
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Self-host only: the in-app ADMIN is the instance operator. On hosted instances
// this surface does not exist (the Cloudflare-gated AdminUser console handles ops).
async function requireInstanceAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isSelfHost()) return res.status(404).json({ error: 'Not found' });
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } });
    if (user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) {
    log.error({ err }, 'requireInstanceAdmin lookup failed');
    res.status(500).json({ error: 'Internal error' });
  }
}

router.post('/users', authenticateToken, requireInstanceAdmin, instanceAdminWriteLimiter, validate(createInstanceUserSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { username, email, password } = req.body;
  const normalizedEmail = email.toLowerCase().trim();
  const emailH = hashEmail(normalizedEmail);
  const existing = await prisma.user.findUnique({ where: { emailHash: emailH }, select: { id: true } });
  if (existing) return res.status(409).json({ error: 'A user with that email already exists.' });
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // Random discriminator with retry-on-conflict (mirrors auth.ts register). A
  // single random pick can collide with an existing username#discriminator and
  // would otherwise 500; retry up to MAX_DISCRIM_RETRIES with a fresh value.
  const MAX_DISCRIM_RETRIES = 10;
  for (let attempt = 0; attempt < MAX_DISCRIM_RETRIES; attempt++) {
    const discriminator = crypto.randomInt(10000).toString().padStart(4, '0');
    try {
      const user = await prisma.user.create({
        data: {
          username, discriminator,
          email: encryptSecret(normalizedEmail), emailHash: emailH,
          passwordHash,
          emailVerified: true, status: 'offline', dateOfBirth: new Date('2000-01-01'),
        },
        select: { id: true, username: true, discriminator: true },
      });
      log.info({ userId: user.id }, 'instance admin created a user');
      return res.status(200).json(user);
    } catch (createErr: any) {
      // P2002 = unique constraint violation (username+discriminator or emailHash).
      if (createErr?.code === 'P2002') {
        const fields = createErr.meta?.target;
        if (Array.isArray(fields) && fields.includes('emailHash')) {
          // TOCTOU race: another request created this email between the check above and now.
          return res.status(409).json({ error: 'A user with that email already exists.' });
        }
        if (attempt === MAX_DISCRIM_RETRIES - 1) {
          return res.status(400).json({ error: 'All discriminators for this username are taken. Please choose a different username.' });
        }
        continue;
      }
      throw createErr;
    }
  }
}));

router.post('/users/:userId/reset-password', authenticateToken, requireInstanceAdmin, instanceAdminWriteLimiter, validate(resetInstanceUserPasswordSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.params.userId as string;
  const { newPassword } = req.body;
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) return res.status(404).json({ error: 'User not found' });
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) } });
  await prisma.session.deleteMany({ where: { userId } });
  log.info({ userId }, 'instance admin reset a user password');
  res.status(200).json({ success: true });
}));

export default router;
