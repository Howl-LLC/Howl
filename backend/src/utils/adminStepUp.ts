// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin step-up proof.
 *
 * Destructive admin endpoints (reset-password, disable-mfa, change-email,
 * delete-sessions) require a fresh password re-prompt within the last 5
 * minutes. Prevents a single compromised admin session from chaining
 * multiple destructive actions silently.
 *
 * Proof is stored in Redis (primary) with an in-memory fallback for dev.
 */

import { redis } from '../redis.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';

const STEP_UP_TTL_SECONDS = 5 * 60;
const MAX_STEPUP_MAP_SIZE = 10_000;

const stepUpFallback = new Map<string, number>();

function key(adminId: string): string {
  return `adminStepUp:${adminId}`;
}

export async function setAdminStepUp(adminId: string): Promise<void> {
  if (redis) {
    await redis.set(key(adminId), '1', 'EX', STEP_UP_TTL_SECONDS);
    return;
  }
  cappedMapSet(stepUpFallback, adminId, Date.now() + STEP_UP_TTL_SECONDS * 1000, MAX_STEPUP_MAP_SIZE);
}

export async function hasAdminStepUp(adminId: string): Promise<boolean> {
  if (redis) {
    const val = await redis.get(key(adminId));
    return val !== null;
  }
  const expiresAt = stepUpFallback.get(adminId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    stepUpFallback.delete(adminId);
    return false;
  }
  return true;
}

export async function clearAdminStepUp(adminId: string): Promise<void> {
  if (redis) {
    await redis.del(key(adminId));
    return;
  }
  stepUpFallback.delete(adminId);
}
