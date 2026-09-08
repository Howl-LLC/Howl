// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Unit tests for the admin enrollment proof util: token mint
 * claims and ceremony-marker set/get on the dev fallback store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const ADMIN_JWT_SECRET = 'test-admin-jwt-secret-for-vitest';
process.env.ADMIN_JWT_SECRET = ADMIN_JWT_SECRET;
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.NODE_ENV = 'test';

vi.mock('../src/redis.js', () => ({ redis: null }));
vi.mock('../src/db.js', () => ({ prisma: {} }));
vi.mock('../src/logger.js', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {} }) },
}));

const ADMIN_ID = '00000000-0000-0000-0000-00000000cccc';

describe('adminEnrollment util', () => {
  beforeEach(async () => {
    const mod = await import('../src/utils/adminEnrollment.js');
    mod._resetEnrollMarkersForTests();
  });

  it('mints an enrollment token carrying scope, needs, and a unique jti', async () => {
    const { mintAdminEnrollmentToken } = await import('../src/utils/adminEnrollment.js');
    const a = mintAdminEnrollmentToken(ADMIN_ID, ['totp', 'passkey']);
    const b = mintAdminEnrollmentToken(ADMIN_ID, ['passkey']);
    expect(a.needs).toEqual(['totp', 'passkey']);
    const decodedA = jwt.verify(a.enrollmentToken, ADMIN_JWT_SECRET) as any;
    const decodedB = jwt.verify(b.enrollmentToken, ADMIN_JWT_SECRET) as any;
    expect(decodedA.scope).toBe('admin-enrollment');
    expect(decodedA.adminId).toBe(ADMIN_ID);
    expect(decodedA.needs).toEqual(['totp', 'passkey']);
    expect(decodedB.needs).toEqual(['passkey']);
    expect(typeof decodedA.jti).toBe('string');
    expect(decodedA.jti).not.toBe(decodedB.jti);
    // 15m TTL
    expect(decodedA.exp - decodedA.iat).toBe(15 * 60);
  });

  it('stores and retrieves a ceremony marker scoped to (jti, factor)', async () => {
    const { setEnrollCeremonyMarker, getEnrollCeremonyMarker } = await import('../src/utils/adminEnrollment.js');
    await setEnrollCeremonyMarker('jti-1', 'totp', ADMIN_ID);
    expect(await getEnrollCeremonyMarker('jti-1', 'totp')).toBe(ADMIN_ID);
    expect(await getEnrollCeremonyMarker('jti-1', 'passkey')).toBeNull();
    expect(await getEnrollCeremonyMarker('jti-2', 'totp')).toBeNull();
  });

  it('reset helper clears markers', async () => {
    const mod = await import('../src/utils/adminEnrollment.js');
    await mod.setEnrollCeremonyMarker('jti-1', 'passkey', ADMIN_ID);
    mod._resetEnrollMarkersForTests();
    expect(await mod.getEnrollCeremonyMarker('jti-1', 'passkey')).toBeNull();
  });
});
