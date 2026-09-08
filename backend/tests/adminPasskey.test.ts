// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin passkey + enrollment endpoints — integration-level checks.
 *
 * WebAuthn crypto itself is not re-tested here (that lives in
 * @simplewebauthn/server). These tests focus on the wiring around it:
 * scope/token validation, single-use enforcement on enrollment tokens,
 * and the enrollment-complete gating logic (every factor in the
 * token's `needs` must carry a ceremony marker bound to that token's jti,
 * with the DB enrollment state kept only as defense-in-depth).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setEnrollCeremonyMarker, _resetEnrollMarkersForTests } from '../src/utils/adminEnrollment.js';

const ADMIN_JWT_SECRET = 'test-admin-jwt-secret-for-vitest';
process.env.ADMIN_JWT_SECRET = ADMIN_JWT_SECRET;
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.NODE_ENV = 'test';

const ADMIN_ID = '00000000-0000-0000-0000-00000000aaaa';

// Mutable state so tests can flip between "mfa on" / "mfa off" / etc.
const adminRow = {
  id: ADMIN_ID,
  email: 'admin@example.com',
  username: 'admin',
  role: 'owner',
  forcePasswordChange: false,
  mfaEnabled: true,
  _count: { passkeys: 1 },
};
let adminRowOverride: Partial<typeof adminRow> = {};

vi.mock('../src/db.js', () => ({
  prisma: {
    adminUser: {
      findUnique: vi.fn(async () => ({ ...adminRow, ...adminRowOverride })),
      update: vi.fn(async () => ({})),
    },
    adminPasskey: {
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    adminSession: {
      create: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock('../src/redis.js', () => ({ redis: null }));

vi.mock('../src/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {},
    }),
  },
}));

vi.mock('../src/services/mfaCrypto.js', () => ({
  hashEmail: (e: string) => `hash:${e}`,
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}));

vi.mock('../src/rateLimitStore.js', () => ({
  createRateLimitStore: () => undefined,
  // The router module is imported once, so every limiter shares one
  // in-memory store across this whole file and the enrollment suite alone
  // exceeds the write limiter's max of 10. Limiter behaviour is not what
  // these tests cover, so skip it (the real defaults still apply in prod).
  RATE_LIMIT_DEFAULTS: { skip: () => true },
}));

async function makeApp() {
  const routerMod = await import('../src/routes/adminPasskey.js');
  const app = express();
  app.use(express.json());
  app.use('/admin/auth', routerMod.default);
  return app;
}

function enrollmentToken(jti: string = crypto.randomUUID(), needs: string[] = ['totp', 'passkey']): string {
  // jti doubles as the single-use fingerprint disambiguator across tests.
  return jwt.sign(
    { adminId: ADMIN_ID, scope: 'admin-enrollment', needs, jti },
    ADMIN_JWT_SECRET,
    { expiresIn: '15m' },
  );
}

function passkeyLoginToken(scope = 'admin-passkey-login'): string {
  return jwt.sign(
    { adminId: ADMIN_ID, scope, jti: crypto.randomUUID() },
    ADMIN_JWT_SECRET,
    { expiresIn: '5m' },
  );
}

beforeEach(() => {
  adminRowOverride = {};
  vi.clearAllMocks();
  _resetEnrollMarkersForTests();
});

describe('POST /enrollment/complete', () => {
  async function markBoth(jti: string) {
    await setEnrollCeremonyMarker(jti, 'totp', ADMIN_ID);
    await setEnrollCeremonyMarker(jti, 'passkey', ADMIN_ID);
  }

  it('issues an admin JWT when the ceremonies were performed under this token', async () => {
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const jti = crypto.randomUUID();
    await markBoth(jti);
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: enrollmentToken(jti) });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.id).toBe(ADMIN_ID);
    const decoded = jwt.verify(res.body.token, ADMIN_JWT_SECRET) as any;
    expect(decoded.scope).toBe('admin');
  });

 it('refuses a pocketed token even when DB state is fully enrolled', async () => {
    // The filed exploit, inverted: the account got enrolled out-of-band
    // (by the legitimate admin), but THIS token holder performed no
    // ceremony, so no markers exist under its jti.
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: enrollmentToken() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enrollment incomplete');
    expect(res.body.token).toBeUndefined();
  });

  it('refuses when ceremonies were bound to a different token (cross-jti)', async () => {
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    await markBoth(crypto.randomUUID());
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: enrollmentToken(crypto.randomUUID()) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enrollment incomplete');
  });

  it('refuses when a marker belongs to a different admin', async () => {
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const jti = crypto.randomUUID();
    await setEnrollCeremonyMarker(jti, 'totp', ADMIN_ID);
    await setEnrollCeremonyMarker(jti, 'passkey', '00000000-0000-0000-0000-000000000bad');
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: enrollmentToken(jti) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enrollment incomplete');
  });

  it('a needs:[passkey] token completes with only the passkey marker', async () => {
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const jti = crypto.randomUUID();
    await setEnrollCeremonyMarker(jti, 'passkey', ADMIN_ID);
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: enrollmentToken(jti, ['passkey']) });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
  });

  it('keeps the DB-state check as defense-in-depth (markers alone are not enough)', async () => {
    adminRowOverride = { mfaEnabled: false, _count: { passkeys: 1 } };
    const app = await makeApp();
    const jti = crypto.randomUUID();
    await markBoth(jti);
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: enrollmentToken(jti) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enrollment incomplete');
  });

  it('refuses a token with a null adminId claim (marker type guard)', async () => {
    // A forged claim of adminId:null must not slip the marker loop by
    // matching an absent (null) marker.
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const nullAdmin = jwt.sign(
      { adminId: null, scope: 'admin-enrollment', needs: ['totp', 'passkey'], jti: crypto.randomUUID() },
      ADMIN_JWT_SECRET,
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: nullAdmin });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enrollment incomplete');
    expect(res.body.token).toBeUndefined();
  });

  it('rejects an old-format token (no jti/needs)', async () => {
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const oldFormat = jwt.sign({ adminId: ADMIN_ID, scope: 'admin-enrollment' }, ADMIN_JWT_SECRET, { expiresIn: '15m' });
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: oldFormat });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('rejects a token with the wrong scope', async () => {
    const wrong = jwt.sign({ adminId: ADMIN_ID, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '15m' });
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: wrong });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('rejects an expired enrollment token', async () => {
    const expired = jwt.sign({ adminId: ADMIN_ID, scope: 'admin-enrollment' }, ADMIN_JWT_SECRET, { expiresIn: '-1s' });
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/enrollment/complete')
      .send({ enrollmentToken: expired });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('single-use: rejects a token that was already consumed', async () => {
    adminRowOverride = { mfaEnabled: true, _count: { passkeys: 1 } };
    const app = await makeApp();
    const jti = crypto.randomUUID();
    await markBoth(jti);
    const token = enrollmentToken(jti);
    const first = await request(app).post('/admin/auth/enrollment/complete').send({ enrollmentToken: token });
    expect(first.status).toBe(200);
    const second = await request(app).post('/admin/auth/enrollment/complete').send({ enrollmentToken: token });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already used/i);
  });
});

describe('POST /passkey/login/begin', () => {
  it('rejects tokens with the wrong scope', async () => {
    const app = await makeApp();
    const enrollment = jwt.sign({ adminId: ADMIN_ID, scope: 'admin-enrollment' }, ADMIN_JWT_SECRET, { expiresIn: '5m' });
    const res = await request(app).post('/admin/auth/passkey/login/begin').send({ passkeyToken: enrollment });
    expect(res.status).toBe(401);
  });

  it('rejects admins with zero passkeys', async () => {
    const app = await makeApp();
    const res = await request(app).post('/admin/auth/passkey/login/begin').send({ passkeyToken: passkeyLoginToken() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no passkeys/i);
  });
});

describe('POST /passkey/login/finish', () => {
  it('rejects a challenge token with the wrong scope', async () => {
    const app = await makeApp();
    const wrongScope = jwt.sign(
      { challenge: 'abc', adminId: ADMIN_ID, scope: 'admin-passkey-register' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app)
      .post('/admin/auth/passkey/login/finish')
      .send({
        challengeToken: wrongScope,
        credential: {
          id: 'x',
          rawId: 'x',
          type: 'public-key',
          response: { clientDataJSON: 'x' },
        },
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/scope/i);
  });
});
