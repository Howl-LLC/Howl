// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * User security event audit helper.
 *
 * Writes one UserSecurityEvent row per security-sensitive state change so
 * the owning user can review activity on their own account ("did someone
 * change my password last night?") without waiting on admin triage. See
 * routes/securityEvents.ts for the read endpoint.
 *
 * Design:
 *   - Fire-and-forget: the emit must NEVER block or fail its calling route.
 *     Errors surface as structured pino warn lines; the route always sees
 *     a resolved promise.
 *   - Closed eventType set (UserSecurityEventType below). Adding a new
 *     value means adding it here + updating the list endpoint schema +
 *     documenting it in the schema.prisma model comment.
 *   - metadata must NEVER contain secrets. The helper doesn't enforce
 *     this at runtime; callers are responsible. Guidance:
 *     email change records `{ newEmailHash: <hmac> }`, not `{ newEmail }`;
 *     SSO login records `{ provider }`; session revoke records
 *     `{ sessionId }`. Anything touching password / token / recovery code /
 *     MFA secret does NOT belong in metadata.
 */

import crypto from 'crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { hashIp } from '../utils/sessionUtils.js';

const log = logger.child({ module: 'securityEvents' });

/**
 * Closed set of security event types. Adding a new value: add it here,
 * mirror it in schemas.ts listSecurityEventsQuery, and reference it in
 * prisma/schema.prisma's UserSecurityEvent.eventType doc comment.
 */
export const USER_SECURITY_EVENT_TYPES = [
  'login_success',
  'login_new_device',
  'password_changed',
  'email_change_requested',
  'email_change_confirmed',
  'mfa_totp_enabled',
  'mfa_totp_disabled',
  'mfa_recovery_regen',
  'passkey_added',
  'passkey_removed',
  'session_revoked',
  'logout_all',
  'self_delete_initiated',
] as const;

export type UserSecurityEventType = (typeof USER_SECURITY_EVENT_TYPES)[number];

type EmitReq = {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string | null;
} | null
  | undefined;

/**
 * sha256(user-agent) truncated to 16 hex chars. Matches the storage
 * footprint of `hashIp` (sessionUtils.ts); enough entropy for
 * "same device?" comparison across events without storing raw UA.
 */
function hashUserAgent(ua: string): string {
  return crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
}

/**
 * Extract caller IP using the same XFF-first-entry rule as sessionUtils
 * createSession. Falls back to req.ip. Returns null when neither source
 * exists (e.g. synthetic test req objects without headers).
 */
function extractIp(req: EmitReq): string | null {
  if (!req) return null;
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? null;
}

function extractUserAgent(req: EmitReq): string | null {
  if (!req) return null;
  const ua = req.headers?.['user-agent'];
  return typeof ua === 'string' ? ua : null;
}

/**
 * Emit a security event for `userId`. Returns a Promise<void> that ALWAYS
 * resolves — internal errors become structured warn logs, never thrown.
 *
 * Callers may `void`-drop the promise or `.catch(() => {})` it; both are
 * safe. The helper never rethrows.
 */
export async function emitUserSecurityEvent(
  userId: string,
  eventType: UserSecurityEventType,
  req: EmitReq,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const rawIp = extractIp(req);
    const rawUa = extractUserAgent(req);
    const ipMasked = rawIp ? hashIp(rawIp) : null;
    const userAgentHash = rawUa ? hashUserAgent(rawUa) : null;

    await prisma.userSecurityEvent.create({
      data: {
        userId,
        eventType,
        ipMasked: ipMasked ?? undefined,
        userAgentHash: userAgentHash ?? undefined,
        metadata: metadata ? (metadata as object) : undefined,
      },
    });

    // Mirror to structured logs — useful for forensic tracing if the
    // UserSecurityEvent row is later cascade-deleted with the user (GDPR).
    // ipMasked / userAgentHash are both hashes, never raw.
    log.info(
      { securityEvent: eventType, userId, ipMasked, userAgentHash },
      'user security event emitted',
    );
  } catch (err) {
    // Never propagate — an audit failure must never break the caller's
    // happy path. Log enough detail for triage without leaking PII.
    log.warn(
      { err, userId, eventType },
      'failed to persist UserSecurityEvent',
    );
  }
}
