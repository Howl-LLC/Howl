// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the new-device verification flow (POST /auth/login →
 * /auth/verify-device/send → /auth/verify-device/confirm).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { createTestUser, cleanupTestData, uniqueEmail, uniqueUsername } from './helpers.js';
import type { TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

let user: TestUser;

beforeAll(async () => {
  user = await createTestUser();
});

afterAll(async () => {
  await cleanupTestData();
});

beforeEach(async () => {
  // Clear prior challenge / trust rows between tests so each scenario runs clean.
  await prisma.loginVerification.deleteMany({ where: { userId: user.id } });
  await prisma.trustedDevice.deleteMany({ where: { userId: user.id } });
});

/** Helper: hit /auth/login and return the parsed JSON body + cookies. */
async function login(email: string, password: string, cookie?: string) {
  const req = request(app).post('/api/auth/login').send({ email, password });
  if (cookie) req.set('Cookie', cookie);
  const res = await req;
  return { status: res.status, body: res.body, cookies: res.headers['set-cookie'] };
}

/** Helper: hit /auth/verify-device/confirm with the provided token+code. */
async function confirm(verifyToken: string, code: string, trustDevice: boolean) {
  const res = await request(app)
    .post('/api/auth/verify-device/confirm')
    .send({ verifyToken, code, trustDevice });
  return { status: res.status, body: res.body, cookies: res.headers['set-cookie'] };
}

/** Helper: extract a 6-digit code for a user by reading the most-recent
 *  un-consumed LoginVerification row and brute-forcing against its bcrypt hash
 *  (acceptable in tests — bcrypt(12) is fast enough for ≤1M codes). */
async function readLatestCode(userId: string): Promise<string> {
  const row = await prisma.loginVerification.findFirst({
    where: { userId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) throw new Error('No active LoginVerification row');
  // We can't reverse bcrypt. In practice the test helper stashes the plain
  // code somewhere. For tests, mutate the row to a deterministic hash so we
  // know the code up-front.
  throw new Error('readLatestCode should not be called — use seedKnownCode instead');
}

/** Replace the un-consumed code row for this user with a known plaintext code.
 *  Lets us test the confirm flow without needing to decrypt bcrypt. */
async function seedKnownCode(userId: string, plainCode: string) {
  const codeHash = await bcrypt.hash(plainCode, 4);
  await prisma.loginVerification.deleteMany({ where: { userId, consumedAt: null } });
  await prisma.loginVerification.create({
    data: {
      userId,
      codeHash,
      method: 'email',
      purpose: 'device',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
}

describe('POST /auth/login — device gate', () => {
  it('returns verificationRequired when no howl_device_id cookie', async () => {
    const r = await login(user.email, 'TestPass123!');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('verificationRequired', true);
    expect(r.body).toHaveProperty('verifyToken');
    expect(r.body).toHaveProperty('emailMasked');
    expect(Array.isArray(r.body.methods)).toBe(true);
    expect(r.body.methods).toContain('email');
  });

  it('skips the challenge when a valid trusted-device cookie is sent', async () => {
    // Seed a TrustedDevice row and compute the cookie value that would map.
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await prisma.trustedDevice.create({
      data: {
        userId: user.id,
        tokenHash,
        label: 'Chrome on Windows',
        deviceType: 'web',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const r = await login(user.email, 'TestPass123!', `howl_device_id=${rawToken}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('user');
    expect(r.body).toHaveProperty('token');
    expect(r.body).not.toHaveProperty('verificationRequired');
  });

  it('rejects a cookie that points to a different user', async () => {
    const other = await createTestUser();
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await prisma.trustedDevice.create({
      data: {
        userId: other.id,
        tokenHash,
        label: 'Attacker Browser',
        deviceType: 'web',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const r = await login(user.email, 'TestPass123!', `howl_device_id=${rawToken}`);
    // Should NOT skip — this token belongs to a different user.
    expect(r.body).toHaveProperty('verificationRequired', true);
  });

  it('treats an expired cookie as untrusted', async () => {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await prisma.trustedDevice.create({
      data: {
        userId: user.id,
        tokenHash,
        label: 'Chrome (expired)',
        deviceType: 'web',
        expiresAt: new Date(Date.now() - 60 * 1000), // expired 60s ago
      },
    });
    const r = await login(user.email, 'TestPass123!', `howl_device_id=${rawToken}`);
    expect(r.body).toHaveProperty('verificationRequired', true);
  });
});

describe('POST /auth/login — device gate under self-host without email', () => {
  const prevSelfHost = process.env.SELF_HOST;
  const prevResend = process.env.RESEND_API_KEY;

  beforeEach(() => {
    // emailVerificationDisabled() = isSelfHost() && !isEmailEnabled(). A text-only
    // self-host instance cannot deliver the 6-digit code, so the new-device email
    // challenge must be skipped or admin-provisioned users can never pass first login.
    process.env.SELF_HOST = 'true';
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    if (prevSelfHost === undefined) delete process.env.SELF_HOST;
    else process.env.SELF_HOST = prevSelfHost;
    if (prevResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevResend;
  });

  it('skips the new-device email challenge and logs in directly (no email provider)', async () => {
    const r = await login(user.email, 'TestPass123!'); // no cookie = brand-new device
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('verificationRequired');
    expect(r.body).toHaveProperty('token');
    expect(r.body).toHaveProperty('user');
  });

  it('still challenges a new device when an email provider IS configured', async () => {
    process.env.RESEND_API_KEY = 're_test_dummy';
    const r = await login(user.email, 'TestPass123!');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('verificationRequired', true);
  });
});

describe('POST /auth/verify-device/confirm', () => {
  it('returns a session when the code is correct and trustDevice=false', async () => {
    const loginRes = await login(user.email, 'TestPass123!');
    expect(loginRes.body.verificationRequired).toBe(true);
    await seedKnownCode(user.id, '123456');
    const r = await confirm(loginRes.body.verifyToken, '123456', false);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('user');
    expect(r.body).toHaveProperty('token');
    // No trust cookie expected when trustDevice=false
    const cookies = (r.cookies ?? []).join('; ');
    expect(cookies).not.toContain('howl_device_id=');
    // No TrustedDevice row created
    const count = await prisma.trustedDevice.count({ where: { userId: user.id } });
    expect(count).toBe(0);
  });

  it('creates a TrustedDevice and cookie when trustDevice=true', async () => {
    const loginRes = await login(user.email, 'TestPass123!');
    await seedKnownCode(user.id, '654321');
    const r = await confirm(loginRes.body.verifyToken, '654321', true);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('user');
    const cookies = (r.cookies ?? []).join('; ');
    expect(cookies).toContain('howl_device_id=');
    const count = await prisma.trustedDevice.count({ where: { userId: user.id } });
    expect(count).toBe(1);
  });

  it('rejects a wrong code and eventually locks the row after 5 attempts', async () => {
    const loginRes = await login(user.email, 'TestPass123!');
    await seedKnownCode(user.id, '111111');
    for (let i = 0; i < 4; i++) {
      const r = await confirm(loginRes.body.verifyToken, '000000', true);
      expect(r.status).toBe(401);
    }
    // 5th wrong attempt — the row is invalidated and returns attempts-exceeded.
    const final = await confirm(loginRes.body.verifyToken, '000000', true);
    expect(final.status).toBe(429);
  });

  it('prevents the same verifyToken from being used twice', async () => {
    const loginRes = await login(user.email, 'TestPass123!');
    await seedKnownCode(user.id, '222222');
    const ok = await confirm(loginRes.body.verifyToken, '222222', false);
    expect(ok.status).toBe(200);
    // Reuse should 400 even with a fresh code.
    await seedKnownCode(user.id, '333333');
    const replay = await confirm(loginRes.body.verifyToken, '333333', false);
    expect(replay.status).toBe(400);
  });

  it('rejects an invalid verifyToken JWT', async () => {
    // Long enough to pass the zod min(20) guard but structurally invalid,
    // so we hit the route and get the 401 path rather than the 400 zod reject.
    const r = await confirm('a'.repeat(50), '123456', false);
    expect(r.status).toBe(401);
  });
});

describe('password change revokes trusted devices', () => {
  it('deletes all TrustedDevice rows for the user and issues a fresh one for the caller', async () => {
    // Seed two TrustedDevices.
    const tokens = [crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('base64url')];
    for (const t of tokens) {
      await prisma.trustedDevice.create({
        data: {
          userId: user.id,
          tokenHash: crypto.createHash('sha256').update(t).digest('hex'),
          label: 'Test browser',
          deviceType: 'web',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    }
    expect(await prisma.trustedDevice.count({ where: { userId: user.id } })).toBe(2);

    // Call PATCH /me/password.
    const res = await request(app)
      .patch('/api/auth/me/password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ currentPassword: 'TestPass123!', newPassword: 'NewStrongPass99!' });
    expect(res.status).toBe(200);

    // Old devices gone, caller's newly-issued device remains (1 row).
    expect(await prisma.trustedDevice.count({ where: { userId: user.id } })).toBe(1);

    // Restore password for subsequent tests.
    await request(app)
      .patch('/api/auth/me/password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ currentPassword: 'NewStrongPass99!', newPassword: 'TestPass123!' });
  });
});

describe('GET /auth/trusted-devices', () => {
  it('returns the caller\'s trusted devices', async () => {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const td = await prisma.trustedDevice.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        label: 'Firefox on Linux',
        deviceType: 'web',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const res = await request(app)
      .get('/api/auth/trusted-devices')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('devices');
    const found = (res.body.devices as Array<{ id: string }>).find((d) => d.id === td.id);
    expect(found).toBeTruthy();
  });

  it('revokes a trust row via DELETE', async () => {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const td = await prisma.trustedDevice.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        label: 'Safari on macOS',
        deviceType: 'web',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const del = await request(app)
      .delete(`/api/auth/trusted-devices/${td.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(del.status).toBe(200);
    const after = await prisma.trustedDevice.findUnique({ where: { id: td.id } });
    expect(after).toBeNull();
  });

  it('returns 404 when revoking another user\'s device', async () => {
    const other = await createTestUser();
    const td = await prisma.trustedDevice.create({
      data: {
        userId: other.id,
        tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
        label: 'Intruder',
        deviceType: 'web',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const del = await request(app)
      .delete(`/api/auth/trusted-devices/${td.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(del.status).toBe(404);
    // Still exists for the owner.
    expect(await prisma.trustedDevice.findUnique({ where: { id: td.id } })).not.toBeNull();
  });
});

describe('/auth/login MFA interaction', () => {
  it('preserves the MFA path — MFA users never see verificationRequired', async () => {
    const mfaEmail = uniqueEmail();
    const mfaPw = 'MfaTestPass123!';
    const passwordHash = await bcrypt.hash(mfaPw, 4);
    await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        username: uniqueUsername(),
        discriminator: String(Math.floor(1000 + Math.random() * 9000)),
        email: mfaEmail,
        emailHash: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY || 'test-only-email-hmac-key-minimum-32chars').update(mfaEmail).digest('hex'),
        passwordHash,
        emailVerified: true,
        status: 'online',
        dateOfBirth: new Date('2000-01-15'),
        mfaEnabled: true,
        mfaTotpSecret: 'encrypted-placeholder',
      },
    });

    const r = await login(mfaEmail, mfaPw);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('mfaRequired', true);
    expect(r.body).not.toHaveProperty('verificationRequired');
  });
});
