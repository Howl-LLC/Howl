// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin refresh-token reuse detection.
 *
 * The /api/admin/auth/refresh endpoint rotates both the access and refresh
 * token on every call. If an old refresh token gets replayed (attacker +
 * legitimate user both hold a copy), the second caller's lookup misses the
 * DB — but if we recorded the just-rotated hash in a short-lived Redis
 * cache, the miss-path can detect the reuse, kill every session for that
 * admin, and force re-auth. These tests exercise:
 *
 *   1. Happy path — valid refresh returns a new token pair and records the
 *      old hash in the consumed cache.
 *   2. Reuse path — second call with the same pre-rotation hash triggers
 *      session-kill + warn log.
 *   3. Garbage path — unknown hash with no consumed-cache hit returns 401
 *      with no session-kill side effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const ADMIN_JWT_SECRET = 'test-admin-jwt-secret-for-vitest';
process.env.ADMIN_JWT_SECRET = ADMIN_JWT_SECRET;
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.NODE_ENV = 'test';

const ADMIN_ID = '00000000-0000-0000-0000-0000000000aa';
const REFRESH_COOKIE_NAME = 'howl_admin_refresh';

// Mutable prisma stub — each test tunes findFirst / update / deleteMany
// behaviour and asserts on their call records.
const prismaStub = {
  adminSession: {
    findFirst: vi.fn(),
    update: vi.fn(async (args: unknown) => args),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  adminUser: {
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
  },
  adminPasskey: { count: vi.fn(async () => 0) },
};

vi.mock('../src/db.js', () => ({ prisma: prismaStub }));

// Redis mock — kv-backed fake. Provides the subset of ioredis API our
// helpers use: get, set (with 'EX' arg), setex, del. Each test clears the
// map via beforeEach.
const redisStore = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    redisStore.set(k, v);
    return 'OK';
  }),
  setex: vi.fn(async (k: string, _ttl: number, v: string) => {
    redisStore.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => {
    redisStore.delete(k);
    return 1;
  }),
};

vi.mock('../src/redis.js', () => ({
  redis: redisMock,
  // The admin auth module imports these but /refresh doesn't call them.
  getLoginLockout: vi.fn(async () => null),
  setLoginLockout: vi.fn(async () => undefined),
  deleteLoginLockout: vi.fn(async () => undefined),
}));

// Capture warn calls so we can assert on the security-event log line.
const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
vi.mock('../src/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => {},
      warn: (obj: Record<string, unknown>, msg: string) => {
        warnCalls.push({ obj, msg });
      },
      error: () => {},
      fatal: () => {},
      debug: () => {},
    }),
  },
}));

// Track session-cache invalidation calls.
const invalidateForUserMock = vi.fn();
vi.mock('../src/middleware/adminAuth.js', () => ({
  ADMIN_JWT_SECRET,
  authenticateAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticateAdminOrEnrollment: (_req: unknown, _res: unknown, next: () => void) => next(),
  invalidateAdminSessionCache: vi.fn(),
  invalidateAdminSessionCacheForUser: invalidateForUserMock,
}));

vi.mock('../src/services/mfaCrypto.js', () => ({
  hashEmail: (e: string) => `hash:${e}`,
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}));

vi.mock('../src/rateLimitStore.js', () => ({
  createRateLimitStore: () => undefined,
  RATE_LIMIT_DEFAULTS: {},
}));

vi.mock('../src/socketHandlers/infrastructure.js', () => ({
  cappedMapSet: (map: Map<string, unknown>, k: string, v: unknown) => {
    map.set(k, v);
  },
}));

function hashToken(t: string): string {
  return crypto.createHash('sha256').update(t).digest('hex');
}

async function makeApp() {
  const routerMod = await import('../src/routes/adminAuth.js');
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/admin/auth', routerMod.default);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  warnCalls.length = 0;
});

describe('POST /admin/auth/refresh — reuse detection', () => {
  it('happy path: valid refresh returns a new token and records the old hash as consumed', async () => {
    const app = await makeApp();
    const oldRefresh = 'good-refresh-token';
    const oldHash = hashToken(oldRefresh);

    prismaStub.adminSession.findFirst.mockResolvedValueOnce({
      id: 'sess-1',
      adminUserId: ADMIN_ID,
      tokenHash: hashToken('old-access'),
      refreshTokenHash: oldHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 60_000),
      adminUser: { id: ADMIN_ID },
    });

    const res = await request(app)
      .post('/admin/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${oldRefresh}`]);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(prismaStub.adminSession.update).toHaveBeenCalledTimes(1);
    expect(prismaStub.adminSession.deleteMany).not.toHaveBeenCalled();

    // The pre-rotation hash must now be in the Redis consumed cache.
    expect(redisStore.get(`admin:refresh:consumed:${oldHash}`)).toBe(ADMIN_ID);
  });

  it('reuse path: replaying a just-rotated refresh hash kills all admin sessions and warns', async () => {
    const app = await makeApp();
    const staleRefresh = 'stale-refresh-token';
    const staleHash = hashToken(staleRefresh);

    // Prime the consumed cache as if the happy path just ran.
    redisStore.set(`admin:refresh:consumed:${staleHash}`, ADMIN_ID);

    // Second caller's findFirst misses (the DB row now holds a NEW hash).
    prismaStub.adminSession.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/admin/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${staleRefresh}`]);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid refresh token');

    // All admin sessions for the compromised admin deleted.
    expect(prismaStub.adminSession.deleteMany).toHaveBeenCalledWith({
      where: { adminUserId: ADMIN_ID },
    });
    expect(invalidateForUserMock).toHaveBeenCalledWith(ADMIN_ID);

    // Security-event log emitted.
    const sec = warnCalls.find((c) => (c.obj as { securityEvent?: string }).securityEvent === 'admin_refresh_reuse');
    expect(sec).toBeDefined();
    expect(sec!.obj.adminId).toBe(ADMIN_ID);
    expect(sec!.msg).toMatch(/reuse detected/i);
  });

  it('garbage path: unknown hash with no consumed-cache hit returns 401 without session kill', async () => {
    const app = await makeApp();
    prismaStub.adminSession.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/admin/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=totally-made-up`]);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid refresh token');
    expect(prismaStub.adminSession.deleteMany).not.toHaveBeenCalled();
    expect(invalidateForUserMock).not.toHaveBeenCalled();
    const sec = warnCalls.find((c) => (c.obj as { securityEvent?: string }).securityEvent === 'admin_refresh_reuse');
    expect(sec).toBeUndefined();
  });

  it('no-cookie path: missing refresh cookie returns 401 without any lookup', async () => {
    const app = await makeApp();
    const res = await request(app).post('/admin/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No refresh token');
    expect(prismaStub.adminSession.findFirst).not.toHaveBeenCalled();
    expect(prismaStub.adminSession.deleteMany).not.toHaveBeenCalled();
  });
});
