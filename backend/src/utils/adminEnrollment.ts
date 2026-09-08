// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin enrollment proof.
 *
 * The enrollment token carries { jti, needs } and each ceremony completed
 * UNDER that token writes a marker keyed by the jti. Redeeming the token
 * for a session requires a marker for every factor in `needs`, so a
 * pocketed password-only token can never ride on ceremonies someone else
 * performed (proof at issuance, not state at redemption).
 *
 * Marker TTL (20m) deliberately exceeds the token TTL (15m) so a marker
 * cannot expire before its token. Redis primary, capped-Map fallback for
 * dev/test (same pattern as utils/adminStepUp.ts).
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { redis } from '../redis.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';
import { ADMIN_JWT_SECRET } from '../middleware/adminAuth.js';

export type EnrollFactor = 'totp' | 'passkey';

const ENROLLMENT_TOKEN_TTL = '15m';
const MARKER_TTL_SECONDS = 20 * 60;
const MAX_MARKER_MAP_SIZE = 10_000;

const markerFallback = new Map<string, { adminId: string; expiresAt: number }>();

function markerKey(jti: string, factor: EnrollFactor): string {
  return `adminEnroll:${jti}:${factor}`;
}

export function mintAdminEnrollmentToken(
  adminId: string,
  needs: EnrollFactor[],
): { enrollmentToken: string; needs: EnrollFactor[] } {
  const enrollmentToken = jwt.sign(
    { adminId, scope: 'admin-enrollment', needs, jti: crypto.randomUUID() },
    ADMIN_JWT_SECRET,
    { expiresIn: ENROLLMENT_TOKEN_TTL },
  );
  return { enrollmentToken, needs };
}

export async function setEnrollCeremonyMarker(
  jti: string,
  factor: EnrollFactor,
  adminId: string,
): Promise<void> {
  if (redis) {
    await redis.set(markerKey(jti, factor), adminId, 'EX', MARKER_TTL_SECONDS);
    return;
  }
  cappedMapSet(
    markerFallback,
    markerKey(jti, factor),
    { adminId, expiresAt: Date.now() + MARKER_TTL_SECONDS * 1000 },
    MAX_MARKER_MAP_SIZE,
  );
}

export async function getEnrollCeremonyMarker(
  jti: string,
  factor: EnrollFactor,
): Promise<string | null> {
  if (redis) {
    return redis.get(markerKey(jti, factor));
  }
  const entry = markerFallback.get(markerKey(jti, factor));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    markerFallback.delete(markerKey(jti, factor));
    return null;
  }
  return entry.adminId;
}

/** Test-only: clear the dev fallback store between cases. */
export function _resetEnrollMarkersForTests(): void {
  markerFallback.clear();
}
