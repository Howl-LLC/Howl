// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Integration tests for GET /api/admin/analytics/protocol-distribution.
 *
 * Covers: empty-state, seeded snapshots, threshold computation,
 * invalid threshold validation, and auth rejection.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret-for-vitest';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

describe('GET /api/admin/analytics/protocol-distribution', () => {
  let adminToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    // Create an AdminUser + AdminSession so the auth middleware passes.
    const admin = await prisma.adminUser.create({
      data: {
        email: `test-admin-${Date.now()}@test.com`,
        username: `testadmin_${Date.now()}`,
        passwordHash: '$2b$04$dummyhashnotusedfortestlogin000000000000000000000',
        role: 'superadmin',
      },
    });
    adminUserId = admin.id;

    adminToken = jwt.sign(
      { adminId: admin.id, scope: 'admin' },
      ADMIN_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    await prisma.adminSession.create({
      data: {
        adminUserId: admin.id,
        tokenHash: hashToken(adminToken),
        deviceName: 'Test Runner',
        os: 'Test',
      },
    });
  });

  beforeEach(async () => {
    await prisma.protocolDistributionSnapshot.deleteMany({});
  });

  afterAll(async () => {
    await prisma.protocolDistributionSnapshot.deleteMany({});
    // Clean up the admin session + user we created.
    await prisma.adminSession.deleteMany({ where: { adminUserId } });
    await prisma.adminAuditLog.deleteMany({ where: { adminId: adminUserId } });
    await prisma.adminUser.delete({ where: { id: adminUserId } }).catch(() => {});
  });

  it('returns empty snapshots and initialized current when no data', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/protocol-distribution?range=7d')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([]);
    expect(res.body.current.byPlatform).toBeDefined();
    expect(res.body.current.byPlatform.electron).toEqual({ total: 0, byBuildDate: {} });
    expect(res.body.current.byPlatform.web).toEqual({ total: 0, byBuildDate: {} });
    expect(res.body.current.byPlatform.unknown).toEqual({ total: 0, byBuildDate: {} });
  });

  it('returns seeded snapshots within range', async () => {
    await prisma.protocolDistributionSnapshot.createMany({
      data: [
        { timestamp: new Date(), buildDate: '2026-04-19', platform: 'web', protocolVersion: 1, count: 10 },
        { timestamp: new Date(), buildDate: '2026-04-19', platform: 'electron', protocolVersion: 1, count: 3 },
      ],
    });
    const res = await request(app)
      .get('/api/admin/analytics/protocol-distribution?range=24h')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.snapshots.length).toBe(2);
  });

  it('computes atOrAboveThreshold when thresholdBuildDate is provided', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/protocol-distribution?range=7d&thresholdBuildDate=2026-04-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.current.atOrAboveThreshold).toBeDefined();
    expect(res.body.current.atOrAboveThreshold.web).toHaveProperty('pct');
    expect(res.body.current.atOrAboveThreshold.electron).toHaveProperty('pct');
  });

  it('rejects invalid thresholdBuildDate with 400', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/protocol-distribution?thresholdBuildDate=not-a-date')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('rejects without admin auth with 401', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/protocol-distribution');
    expect(res.status).toBe(401);
  });
});
