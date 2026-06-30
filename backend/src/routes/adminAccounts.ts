// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { type AdminAuthRequest, requireAdminStepUp } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminCreateAccountSchema, adminAccountIdSchema, adminChangeRoleSchema, adminDisableTargetMfaSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { hashEmail, encryptSecret, decryptSecret } from '../services/mfaCrypto.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { invalidateAdminSessionCacheForUser } from '../middleware/adminAuth.js';
import { logAction } from './adminHelpers.js';

const log = logger.child({ module: 'adminAccounts' });

const router = Router();

router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const accountReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-accounts-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const accountWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-accounts:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function generateTempPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*-_=+';
  const all = upper + lower + digits + symbols;
  const chars: string[] = [];
  const pick = (set: string, n: number) => { for (let i = 0; i < n; i++) chars.push(set[crypto.randomInt(set.length)]); };
  pick(upper, 3);
  pick(lower, 3);
  pick(digits, 3);
  pick(symbols, 2);
  pick(all, 5);
  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// GET /admin/accounts — List all admin accounts
router.get('/', accountReadLimiter, async (req: AdminAuthRequest, res: Response) => {
  try {
    const admins = await prisma.adminUser.findMany({
      select: { id: true, username: true, email: true, role: true, mfaEnabled: true, forcePasswordChange: true, lastLoginAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    const roleOrder: Record<string, number> = { owner: 0, superadmin: 1, admin: 2 };
    admins.sort((a, b) => (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const result = admins.map((a) => {
      let plainEmail: string;
      try { plainEmail = decryptSecret(a.email); } catch { plainEmail = a.email; }
      return { ...a, email: plainEmail };
    });

    res.json(result);
  } catch (err) {
    log.error({ err }, 'List admin accounts error');
    res.status(500).json({ error: 'Failed to list admin accounts' });
  }
});

// POST /admin/accounts — Create admin account
router.post('/', accountWriteLimiter, validate(adminCreateAccountSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const { email, username, password, role } = req.body as { email: string; username: string; password: string; role: string };

    if (role === 'owner') return res.status(403).json({ error: 'Owner accounts cannot be created through the UI' });
    if (role === 'superadmin' && req.adminRole !== 'owner') return res.status(403).json({ error: 'Only owners can create super admin accounts' });

    const normalized = email.trim().toLowerCase();
    const emailH = hashEmail(normalized);

    const existingEmail = await prisma.adminUser.findUnique({ where: { emailHash: emailH }, select: { id: true } });
    if (existingEmail) return res.status(409).json({ error: 'An admin with this email already exists' });

    const existingUsername = await prisma.adminUser.findFirst({ where: { username: { equals: username, mode: 'insensitive' } }, select: { id: true } });
    if (existingUsername) return res.status(409).json({ error: 'An admin with this username already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.adminUser.create({
      data: {
        email: encryptSecret(normalized),
        emailHash: emailH,
        username,
        passwordHash,
        role,
        forcePasswordChange: true,
      },
      select: { id: true, username: true, role: true, mfaEnabled: true, forcePasswordChange: true, lastLoginAt: true, createdAt: true },
    });

    await logAction(req.adminId!, 'create_admin_account', admin.id, { role, username, cfAccessEmail: req.cfAccessEmail });
    log.info({ actorId: req.adminId, targetId: admin.id, role }, 'Admin account created');
    res.json({ ...admin, email: normalized });
  } catch (err) {
    log.error({ err }, 'Create admin account error');
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

// DELETE /admin/accounts/:id — Delete admin account
router.delete('/:id', accountWriteLimiter, validate(adminAccountIdSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const targetId = req.params.id as string;
    if (targetId === req.adminId) return res.status(400).json({ error: 'Cannot delete your own account' });

    const target = await prisma.adminUser.findUnique({ where: { id: targetId }, select: { id: true, role: true, username: true } });
    if (!target) return res.status(404).json({ error: 'Admin account not found' });

    if (target.role === 'owner') return res.status(403).json({ error: 'Owner accounts cannot be deleted through the UI' });
    if (target.role === 'superadmin' && req.adminRole !== 'owner') return res.status(403).json({ error: 'Only owners can delete super admin accounts' });

    await prisma.adminSession.deleteMany({ where: { adminUserId: targetId } });
    invalidateAdminSessionCacheForUser(targetId);
    // Re-assign orphaned audit log entries to the actor performing the deletion
    // so they are preserved (adminId is non-nullable in the schema).
    await prisma.adminAuditLog.updateMany({ where: { adminId: targetId }, data: { adminId: req.adminId! } });
    await logAction(req.adminId!, 'delete_admin_account', targetId, { username: target.username, cfAccessEmail: req.cfAccessEmail });
    await prisma.adminUser.delete({ where: { id: targetId } });

    log.info({ actorId: req.adminId, targetId, targetRole: target.role }, 'Admin account deleted');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Delete admin account error');
    res.status(500).json({ error: 'Failed to delete admin account' });
  }
});

// POST /admin/accounts/:id/reset-password — Generate temp password
router.post('/:id/reset-password', accountWriteLimiter, validate(adminAccountIdSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const targetId = req.params.id as string;
    if (targetId === req.adminId) return res.status(400).json({ error: 'Use change password instead' });

    const target = await prisma.adminUser.findUnique({ where: { id: targetId }, select: { id: true, role: true, username: true } });
    if (!target) return res.status(404).json({ error: 'Admin account not found' });

    if (target.role === 'owner') return res.status(403).json({ error: 'Owner passwords cannot be reset through the UI' });
    if (target.role === 'superadmin' && req.adminRole !== 'owner') return res.status(403).json({ error: 'Only owners can reset super admin passwords' });

    const temporaryPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    await prisma.adminUser.update({
      where: { id: targetId },
      data: { passwordHash, forcePasswordChange: true },
    });

    await prisma.adminSession.deleteMany({ where: { adminUserId: targetId } });
    invalidateAdminSessionCacheForUser(targetId);

    await logAction(req.adminId!, 'reset_admin_password', targetId, { cfAccessEmail: req.cfAccessEmail });
    log.info({ actorId: req.adminId, targetId }, 'Admin password reset');
    res.json({ temporaryPassword });
  } catch (err) {
    log.error({ err }, 'Reset admin password error');
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /admin/accounts/:id/disable-mfa — Two-person recovery: superadmin/owner
// clears another admin's TOTP + all passkeys + forces a password change on
// next login. The target then logs in with their current (or separately
// reset) password and walks through the enrollment wizard again.
router.post('/:id/disable-mfa', accountWriteLimiter, requireAdminStepUp, validate(adminDisableTargetMfaSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const targetId = req.params.id as string;
    if (targetId === req.adminId) return res.status(400).json({ error: 'Use the MFA self-service flow instead' });

    const target = await prisma.adminUser.findUnique({ where: { id: targetId }, select: { id: true, role: true, username: true } });
    if (!target) return res.status(404).json({ error: 'Admin account not found' });

    if (target.role === 'owner') return res.status(403).json({ error: 'Owner MFA cannot be reset through the UI' });
    if (target.role === 'superadmin' && req.adminRole !== 'owner') return res.status(403).json({ error: 'Only owners can reset super admin MFA' });

    await prisma.$transaction([
      prisma.adminPasskey.deleteMany({ where: { adminUserId: targetId } }),
      prisma.adminUser.update({
        where: { id: targetId },
        data: { mfaEnabled: false, mfaTotpSecret: null, forcePasswordChange: true },
      }),
      prisma.adminSession.deleteMany({ where: { adminUserId: targetId } }),
    ]);
    invalidateAdminSessionCacheForUser(targetId);

    await logAction(req.adminId!, 'admin.mfa_reset', targetId, {
      username: target.username,
      cfAccessEmail: req.cfAccessEmail,
    });
    log.info({ actorId: req.adminId, targetId }, 'Admin MFA reset (passkeys + TOTP cleared)');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Admin MFA reset error');
    res.status(500).json({ error: 'Failed to reset admin MFA' });
  }
});

// PATCH /admin/accounts/:id/role — Change admin role
router.patch('/:id/role', accountWriteLimiter, validate(adminChangeRoleSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const targetId = req.params.id as string;
    const { role } = req.body as { role: string };

    if (role === 'owner') return res.status(403).json({ error: 'Owner role cannot be assigned through the UI' });
    if (targetId === req.adminId) return res.status(400).json({ error: 'Cannot change your own role' });
    if (req.adminRole !== 'owner') return res.status(403).json({ error: 'Only owners can change admin roles' });

    const target = await prisma.adminUser.findUnique({ where: { id: targetId }, select: { id: true, role: true } });
    if (!target) return res.status(404).json({ error: 'Admin account not found' });
    if (target.role === 'owner') return res.status(403).json({ error: 'Owner roles cannot be changed through the UI' });

    const oldRole = target.role;
    await prisma.adminUser.update({ where: { id: targetId }, data: { role } });

    await logAction(req.adminId!, 'change_admin_role', targetId, { oldRole, newRole: role, cfAccessEmail: req.cfAccessEmail });
    log.info({ actorId: req.adminId, targetId, fromRole: oldRole, toRole: role }, 'Admin role changed');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Change admin role error');
    res.status(500).json({ error: 'Failed to change role' });
  }
});

export default router;
