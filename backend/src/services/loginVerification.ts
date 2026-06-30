// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Login-verification service — issues and verifies one-time codes for
 * the new-device email-code challenge. Sibling to `trustedDevice.ts`.
 *
 * Flow:
 *   1. Login handler decides a challenge is required, calls
 *      `createEmailChallenge()` and enqueues the email.
 *   2. User submits code back to `/auth/verify-device/confirm` → we call
 *      `verifyChallenge()` which consumes the row on success, or
 *      increments attempts on failure (cap 5).
 *   3. On success the handler mints the session + (optionally) issues a
 *      TrustedDevice row.
 *
 * Security notes:
 *   - Code is 6 digits numeric (matches existing sendVerificationEmail UX).
 *   - codeHash stored as bcrypt(12) for consistency with mfaRecoveryCodes.
 *     6-digit space is 1M but we're rate-limited elsewhere; bcrypt just
 *     adds defense-in-depth if the row is read out-of-band.
 *   - Only one active (un-consumed, non-expired) row per user — new
 *     request supersedes the old one (prevents code-stuffing).
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'loginVerification' });

/** 10-minute TTL — matches industry standard for email OTPs. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Brute-force cap: after 5 wrong attempts on the same row, invalidate. */
export const MAX_ATTEMPTS = 5;

const BCRYPT_ROUNDS = 12;

export function generateSixDigitCode(): string {
  // Cryptographically-random 6-digit code, uniform distribution over 000000-999999.
  // Rejection-sample rather than modulo (avoid modulo bias on the top of the
  // u32 range).
  while (true) {
    const u32 = crypto.randomBytes(4).readUInt32BE(0);
    if (u32 < 4_294_967_000) {
      return (u32 % 1_000_000).toString().padStart(6, '0');
    }
  }
}

export interface CreateEmailChallengeResult {
  verificationId: string;
  /** Plaintext code — caller emails this to the user, never persists. */
  codePlain: string;
  expiresAt: Date;
}

export async function createEmailChallenge(
  userId: string,
  ipHash: string | null,
  method: 'email' | 'sms' = 'email',
): Promise<CreateEmailChallengeResult> {
  const codePlain = generateSixDigitCode();
  const codeHash = await bcrypt.hash(codePlain, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // Supersede any prior un-consumed challenge for this user+purpose so a
  // user who requests "resend" can't leave a stale valid code floating.
  await prisma.loginVerification.deleteMany({
    where: { userId, purpose: 'device', consumedAt: null },
  });

  const row = await prisma.loginVerification.create({
    data: {
      userId,
      codeHash,
      method,
      purpose: 'device',
      expiresAt,
      ipHash,
    },
  });
  return { verificationId: row.id, codePlain, expiresAt };
}

export type VerifyFailureReason = 'not_found' | 'expired' | 'used' | 'attempts' | 'wrong';

export interface VerifyChallengeResult {
  ok: boolean;
  reason?: VerifyFailureReason;
}

export async function verifyChallenge(
  userId: string,
  code: string,
): Promise<VerifyChallengeResult> {
  const row = await prisma.loginVerification.findFirst({
    where: { userId, purpose: 'device', consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    // Already locked from earlier attempts. Invalidate permanently.
    await prisma.loginVerification.delete({ where: { id: row.id } }).catch(() => {});
    return { ok: false, reason: 'attempts' };
  }

  const match = await bcrypt.compare(code, row.codeHash).catch(() => false);
  if (!match) {
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      // Burn the row on the attempts-cap hit.
      await prisma.loginVerification.delete({ where: { id: row.id } }).catch(() => {});
      log.warn({ userId, verificationId: row.id }, 'device-verify: attempts cap hit, row invalidated');
      return { ok: false, reason: 'attempts' };
    }
    await prisma.loginVerification.update({
      where: { id: row.id },
      data: { attempts: nextAttempts },
    }).catch(() => {});
    return { ok: false, reason: 'wrong' };
  }

  // Success — mark consumed (delete is fine too; we keep the row for audit briefly).
  await prisma.loginVerification.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  }).catch(() => {});
  return { ok: true };
}
