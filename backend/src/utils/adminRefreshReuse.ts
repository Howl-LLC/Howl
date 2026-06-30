// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin refresh-token reuse detection.
 *
 * When /api/admin/auth/refresh successfully rotates a refresh token, we
 * write the OLD refresh-token hash into a short-lived Redis "consumed"
 * cache keyed to the admin who owned it. A subsequent /refresh call with
 * the same (now-stale) refresh hash will miss the DB lookup, but hit this
 * cache — signalling that two parties hold or held the token. Mirrors the
 * user-side reuse detection in routes/auth.ts, but uses Redis
 * instead of a previousRefreshTokenHash column on AdminSession.
 *
 * TTL is 60s: long enough to catch racey reuse after a rotation, short
 * enough that a legitimate user's forgotten tab coming back online days
 * later doesn't trigger a session kill.
 *
 * If Redis is unavailable (dev fallback), detection is skipped — admin
 * auth already requires Redis-backed rate limiters in production, so this
 * is acceptable.
 */

import { redis } from '../redis.js';

const CONSUMED_TTL_SECONDS = 60;

function key(refreshHash: string): string {
  return `admin:refresh:consumed:${refreshHash}`;
}

export async function markAdminRefreshConsumed(refreshHash: string, adminId: string): Promise<void> {
  if (!redis) return;
  await redis.set(key(refreshHash), adminId, 'EX', CONSUMED_TTL_SECONDS);
}

export async function getConsumedAdminRefresh(refreshHash: string): Promise<string | null> {
  if (!redis) return null;
  return redis.get(key(refreshHash));
}
