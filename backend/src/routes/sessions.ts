// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, invalidateSessionCache, type AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { hashToken } from '../utils/sessionUtils.js';
import { publishSessionInvalidation } from '../redis.js';
import { emitUserSecurityEvent } from '../services/securityEvents.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();

const sessionMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:session:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many session operations. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

export { hashToken, createSession } from '../utils/sessionUtils.js';

// GET /api/sessions – list all sessions for the current user
router.get('/', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const authHeader = req.headers['authorization'] as string | undefined;
  const currentToken = authHeader?.split(' ')[1] ?? '';
  const currentHash = hashToken(currentToken);

  const sessions = await prisma.session.findMany({
    where: { userId: req.userId },
    orderBy: { lastActiveAt: 'desc' },
    take: 100,
  });

  res.json(sessions.map((s) => ({
    id: s.id,
    deviceName: s.deviceName,
    deviceType: s.deviceType,
    os: s.os,
    ip: s.ip,
    lastActiveAt: s.lastActiveAt,
    createdAt: s.createdAt,
    isCurrent: s.tokenHash === currentHash,
  })));
}));

// DELETE /api/sessions/:sessionId – revoke a single session (remote logout)
router.delete('/:sessionId', validateUuidParams('sessionId'), authenticateToken, sessionMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const sessionId = req.params.sessionId as string;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== req.userId) return res.status(404).json({ error: 'Session not found' });
  invalidateSessionCache(session.tokenHash);
  await prisma.session.delete({ where: { id: sessionId } });
  publishSessionInvalidation(session.tokenHash);
  // Record remote-logout on the caller's audit feed. sessionId is not a secret
  // (it's the public key the client used to invoke this endpoint), so including
  // it is safe.
  void emitUserSecurityEvent(req.userId, 'session_revoked', req, { sessionId });
  res.json({ success: true });
}));

// DELETE /api/sessions – revoke all sessions except current
router.delete('/', authenticateToken, sessionMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const authHeader = req.headers['authorization'] as string | undefined;
  const currentToken = authHeader?.split(' ')[1] ?? '';
  const currentHash = hashToken(currentToken);

  const sessionsToRevoke = await prisma.session.findMany({
    where: { userId: req.userId, NOT: { tokenHash: currentHash } },
    select: { tokenHash: true },
    take: 100,
  });
  for (const s of sessionsToRevoke) {
    invalidateSessionCache(s.tokenHash);
  }
  await prisma.session.deleteMany({
    where: { userId: req.userId, NOT: { tokenHash: currentHash } },
  });
  for (const s of sessionsToRevoke) {
    publishSessionInvalidation(s.tokenHash);
  }
  // Record logout-all on the caller's audit feed.
  void emitUserSecurityEvent(req.userId, 'logout_all', req, { revokedCount: sessionsToRevoke.length });
  res.json({ success: true });
}));

export default router;
