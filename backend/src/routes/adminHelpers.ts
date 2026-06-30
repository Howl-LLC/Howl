// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function paramStr(val: string | string[]): string {
  return Array.isArray(val) ? val[0] : val;
}

export function validateUuidParam(val: string | string[]): string | null {
  const s = paramStr(val);
  return UUID_REGEX.test(s) ? s : null;
}

export const adminLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many admin requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).adminId || getClientIp(req) || 'unknown',
});

export async function logAction(adminId: string, action: string, targetUserId: string | null, details?: Record<string, unknown>) {
  await prisma.adminAuditLog.create({
    data: {
      adminId,
      action,
      targetUserId,
      details: details ? (details as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });
}
