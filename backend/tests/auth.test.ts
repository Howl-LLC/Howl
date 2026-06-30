// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import {
  createTestUser,
  authHeader,
  cleanupTestData,
  uniqueEmail,
  uniqueUsername,
} from './helpers.js';
import type { TestUser } from './helpers.js';
import { encryptSecret } from '../src/services/mfaCrypto.js';
import { prisma } from '../src/db.js';
import * as otplib from 'otplib';

let testUser: TestUser;

beforeAll(async () => {
  testUser = await createTestUser();
});

afterAll(async () => {
  await cleanupTestData();
});

describe('POST /api/auth/register', () => {
  it('returns 200 with valid registration data', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: uniqueUsername(),
        email: uniqueEmail(),
        password: 'StrongPass1!xx',
        dateOfBirth: '2000-01-15',
        agreedToTerms: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('requiresVerification', true);
    expect(res.body).toHaveProperty('userId');
  });

  it('returns 400 for a weak password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: uniqueUsername(),
        email: uniqueEmail(),
        password: 'weak',
        dateOfBirth: '2000-01-15',
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 for a duplicate email', async () => {
    const email = uniqueEmail();

    await request(app)
      .post('/api/auth/register')
      .send({ username: uniqueUsername(), email, password: 'StrongPass1!xx', dateOfBirth: '2000-01-15' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: uniqueUsername(), email, password: 'StrongPass1!xx', dateOfBirth: '2000-01-15' });

    // Could be 400 (already registered) or 200 (resends verification for unverified)
    expect([200, 400]).toContain(res.status);
  });

  it('returns 403 for 13–17 without parental consent acknowledgement', async () => {
    // ToS §3 requires 13–17 to affirm parental/guardian consent. The route
    // returns PARENTAL_CONSENT_REQUIRED when the bit is missing/false.
    const today = new Date();
    const fifteenYearsAgo = `${today.getFullYear() - 15}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: uniqueUsername(),
        email: uniqueEmail(),
        password: 'StrongPass1!xx',
        dateOfBirth: fifteenYearsAgo,
        agreedToTerms: true,
        // parentalConsentAcknowledged omitted
      });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('code', 'PARENTAL_CONSENT_REQUIRED');
  });

  it('accepts 13–17 registration with parentalConsentAcknowledged=true', async () => {
    const today = new Date();
    const fifteenYearsAgo = `${today.getFullYear() - 15}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: uniqueUsername(),
        email: uniqueEmail(),
        password: 'StrongPass1!xx',
        dateOfBirth: fifteenYearsAgo,
        agreedToTerms: true,
        parentalConsentAcknowledged: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('requiresVerification', true);
  });
});

describe('POST /api/auth/login', () => {
  it('returns 401 for wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: 'WrongPassword1!' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns verificationRequired on new device (no howl_device_id cookie)', async () => {
    // With the device-verification feature, a password login from a device
    // the server has never seen returns a verifyToken + email-code challenge
    // instead of a bare token. MFA users are unaffected — they see mfaRequired
    // as before (exercised in the MFA test suite).
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: 'TestPass123!' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('verificationRequired', true);
    expect(res.body).toHaveProperty('verifyToken');
    expect(res.body).toHaveProperty('methods');
    expect(res.body).toHaveProperty('emailMasked');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without auth header', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
  });

  it('returns the user profile with a valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${testUser.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', testUser.id);
    expect(res.body).toHaveProperty('username', testUser.username);
  });
});

describe('PATCH /api/auth/me/status', () => {
  it('updates the user status', async () => {
    const res = await request(app)
      .patch('/api/auth/me/status')
      .set('Authorization', `Bearer ${testUser.token}`)
      .send({ status: 'dnd' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'dnd');
  });
});

describe('GET /api/auth/db-check', () => {
  it('returns a connected status', async () => {
    const res = await request(app).get('/api/auth/db-check');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });
});

describe('PATCH /api/auth/me/email — email change with MFA', () => {
  let mfaUser: TestUser;
  let totpSecret: string;

  beforeAll(async () => {
    mfaUser = await createTestUser();
    totpSecret = otplib.generateSecret();
    await prisma.user.update({
      where: { id: mfaUser.id },
      data: {
        mfaEnabled: true,
        mfaTotpSecret: encryptSecret(totpSecret),
        email: encryptSecret(mfaUser.email),
      },
    });
  });

  // OLD-email code + NEW-email code are the second factor for email change.
  // MFA-enabled users may still pass mfaCode for belt-and-suspenders (see next
  // two tests), but it is no longer load-bearing alone.
  it('initiates email change when MFA user omits mfaCode (OLD+NEW codes are the 2FA)', async () => {
    const res = await request(app)
      .patch('/api/auth/me/email')
      .set('Authorization', `Bearer ${mfaUser.token}`)
      .send({ currentPassword: 'TestPass123!', newEmail: uniqueEmail() });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('requiresVerification', true);
    expect(res.body).toHaveProperty('requiresBothCodes', true);
  });

  it('returns 401 when MFA user provides wrong mfaCode', async () => {
    const res = await request(app)
      .patch('/api/auth/me/email')
      .set('Authorization', `Bearer ${mfaUser.token}`)
      .send({ currentPassword: 'TestPass123!', newEmail: uniqueEmail(), mfaCode: '000000' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'Invalid MFA code');
  });

  it('initiates email change when MFA user provides valid mfaCode', async () => {
    const validCode = otplib.generateSync({ secret: totpSecret });

    const res = await request(app)
      .patch('/api/auth/me/email')
      .set('Authorization', `Bearer ${mfaUser.token}`)
      .send({ currentPassword: 'TestPass123!', newEmail: uniqueEmail(), mfaCode: validCode });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('requiresVerification', true);
  });
});

describe('PATCH /api/auth/me/email — email change without MFA', () => {
  let noMfaUser: TestUser;

  beforeAll(async () => {
    noMfaUser = await createTestUser();
    await prisma.user.update({
      where: { id: noMfaUser.id },
      data: { email: encryptSecret(noMfaUser.email) },
    });
  });

  it('initiates email change without mfaCode for non-MFA user', async () => {
    const res = await request(app)
      .patch('/api/auth/me/email')
      .set('Authorization', `Bearer ${noMfaUser.token}`)
      .send({ currentPassword: 'TestPass123!', newEmail: uniqueEmail() });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('requiresVerification', true);
  });

  it('returns 401 for wrong password', async () => {
    const res = await request(app)
      .patch('/api/auth/me/email')
      .set('Authorization', `Bearer ${noMfaUser.token}`)
      .send({ currentPassword: 'WrongPassword1!', newEmail: uniqueEmail() });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'Current password is incorrect');
  });
});

// `/complete-onboarding` must reject callers who have already onboarded.
// Without this guard, a stolen access token could silently overwrite
// passwordHash / DOB / ToS-consent and convert session compromise into durable
// account takeover.
describe('POST /api/auth/complete-onboarding — re-entry guard', () => {
  it('rejects re-invocation from an already-onboarded user and does not overwrite passwordHash / DOB / ToS', async () => {
    const before = await prisma.user.findUnique({
      where: { id: testUser.id },
      select: { passwordHash: true, dateOfBirth: true, tosAcceptedAt: true, needsOnboarding: true },
    });
    // Sanity: shared test user is onboarded (needsOnboarding defaults to false).
    expect(before?.needsOnboarding).toBe(false);

    const res = await request(app)
      .post('/api/auth/complete-onboarding')
      .set('Authorization', `Bearer ${testUser.token}`)
      .send({
        dateOfBirth: '1990-06-15',
        agreedToTerms: true,
        password: 'AttackerPass9!xx',
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');

    const after = await prisma.user.findUnique({
      where: { id: testUser.id },
      select: { passwordHash: true, dateOfBirth: true, tosAcceptedAt: true },
    });
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.dateOfBirth?.toISOString()).toBe(before?.dateOfBirth?.toISOString());
    expect(after?.tosAcceptedAt).toEqual(before?.tosAcceptedAt);
  });

  it('accepts a legitimate mid-onboarding call (needsOnboarding=true) and installs the password', async () => {
    const onboardingUser = await createTestUser();
    await prisma.user.update({
      where: { id: onboardingUser.id },
      data: { needsOnboarding: true, passwordHash: null, dateOfBirth: null, tosAcceptedAt: null },
    });

    const res = await request(app)
      .post('/api/auth/complete-onboarding')
      .set('Authorization', `Bearer ${onboardingUser.token}`)
      .send({
        dateOfBirth: '1990-06-15',
        agreedToTerms: true,
        password: 'LegitOnboard1!x',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);

    const after = await prisma.user.findUnique({
      where: { id: onboardingUser.id },
      select: { passwordHash: true, needsOnboarding: true, tosAcceptedAt: true },
    });
    expect(after?.passwordHash).not.toBeNull();
    expect(after?.needsOnboarding).toBe(false);
    expect(after?.tosAcceptedAt).not.toBeNull();
  });
});

// SSO login must honor MFA step-up when the account has MFA enrolled.
// Minting an access token, refresh token, and 90-day trusted-device cookie
// immediately on matching provider_providerId would let an attacker who
// compromised the linked Google/Apple/Steam account bypass the victim's
// Howl-side TOTP/passkey.
describe('POST /api/auth/sso/exchange-code — MFA step-up', () => {
  it('returns mfaRequired (no token, no refresh cookie) when the SSO code carries kind=mfa', async () => {
    const { storeSsoCode } = await import('../src/utils/ssoCode.js');
    const jwt = (await import('jsonwebtoken')).default;
    const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-vitest';

    const mfaUser = await createTestUser();
    await prisma.user.update({ where: { id: mfaUser.id }, data: { mfaEnabled: true } });

    const mfaToken = jwt.sign(
      { userId: mfaUser.id, purpose: 'mfa', emailHash: 'test-hash' },
      JWT_SECRET,
      { expiresIn: '5m' },
    );
    const code = await storeSsoCode({ kind: 'mfa', mfaToken, methods: ['totp'] });

    const res = await request(app)
      .post('/api/auth/sso/exchange-code')
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mfaRequired', true);
    expect(res.body).toHaveProperty('mfaToken');
    expect(res.body.methods).toEqual(['totp']);
    // No trusted-device cookie and no refresh cookie on the MFA branch.
    const cookies = (res.headers['set-cookie'] ?? []) as string[];
    expect(cookies.some((c) => c.startsWith('howl_device_id='))).toBe(false);
    expect(cookies.some((c) => c.startsWith('howl_refresh='))).toBe(false);
    // No access token in the body either — the client must complete MFA first.
    expect(res.body.token).toBeUndefined();
  });

  it('returns a bare token for kind=session codes (non-MFA SSO users unchanged)', async () => {
    const { storeSsoCode } = await import('../src/utils/ssoCode.js');
    const jwt = (await import('jsonwebtoken')).default;
    const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-vitest';
    const { generateRefreshToken } = await import('../src/utils/sessionUtils.js');

    const user = await createTestUser();
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = generateRefreshToken();
    const code = await storeSsoCode({ kind: 'session', token, refreshToken });

    const res = await request(app)
      .post('/api/auth/sso/exchange-code')
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token', token);
    expect(res.body.mfaRequired).toBeUndefined();
  });

  it('accepts the mfaToken from the MFA branch at /api/auth/mfa/totp/verify and yields a session', async () => {
    const { storeSsoCode } = await import('../src/utils/ssoCode.js');
    const jwt = (await import('jsonwebtoken')).default;
    const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-vitest';

    const mfaUser = await createTestUser();
    const totpSecret = otplib.generateSecret();
    await prisma.user.update({
      where: { id: mfaUser.id },
      data: {
        mfaEnabled: true,
        mfaTotpSecret: encryptSecret(totpSecret),
      },
    });

    const mfaToken = jwt.sign(
      { userId: mfaUser.id, purpose: 'mfa', emailHash: 'test-hash' },
      JWT_SECRET,
      { expiresIn: '5m' },
    );
    const code = await storeSsoCode({ kind: 'mfa', mfaToken, methods: ['totp'] });

    const exchange = await request(app)
      .post('/api/auth/sso/exchange-code')
      .send({ code });
    expect(exchange.status).toBe(200);
    expect(exchange.body.mfaRequired).toBe(true);

    const validCode = otplib.generateSync({ secret: totpSecret });
    const verify = await request(app)
      .post('/api/auth/mfa/totp/verify')
      .send({ mfaToken: exchange.body.mfaToken, code: validCode });

    expect(verify.status).toBe(200);
    expect(verify.body).toHaveProperty('token');
    expect(verify.body).toHaveProperty('user');
    expect(verify.body.user.id).toBe(mfaUser.id);
  });
});
