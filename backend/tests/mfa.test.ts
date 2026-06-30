// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * MFA regression tests.
 *
 * Passkey enrollment must require password (or TOTP code on SSO-only
 * MFA-enabled accounts) re-auth regardless of current `mfaEnabled` state.
 * The threat model is that a stolen session can otherwise enrol a
 * persistent passkey backdoor that survives password change / reset /
 * trusted-device revocation, because passkey login is passwordless and
 * auto-trusts the device.
 *
 * These tests focus on the re-auth gate only. They do NOT exercise the
 * WebAuthn ceremony itself — the credential object is deliberately invalid,
 * so a request that passes the re-auth gate fails later at the WebAuthn
 * verification step. The gate is what the tests lock in: without password
 * the request must return 400 (missing) or 403 (wrong).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import {
  createTestUser,
  authHeader,
  cleanupTestData,
} from './helpers.js';
import type { TestUser } from './helpers.js';
import { encryptSecret } from '../src/services/mfaCrypto.js';
import { prisma } from '../src/db.js';
import * as otplib from 'otplib';

let testUser: TestUser;
let mfaOnlyUser: TestUser; // SSO-only (no passwordHash), MFA enabled
let mfaTotpSecret: string;

beforeAll(async () => {
  testUser = await createTestUser();

  // SSO-only user: clear passwordHash, enable TOTP MFA.
  mfaOnlyUser = await createTestUser();
  mfaTotpSecret = otplib.generateSecret();
  await prisma.user.update({
    where: { id: mfaOnlyUser.id },
    data: {
      passwordHash: null,
      mfaEnabled: true,
      mfaTotpSecret: encryptSecret(mfaTotpSecret),
    },
  });
});

afterAll(async () => {
  await cleanupTestData();
});

// A deliberately invalid WebAuthn credential — used only to show that the
// re-auth gate is hit BEFORE WebAuthn verification. The gate returns a 400/403
// with the re-auth error; a malformed credential that reached WebAuthn would
// return a different error shape.
const invalidCredential = {
  id: 'aaaa',
  rawId: 'aaaa',
  type: 'public-key' as const,
  response: { clientDataJSON: 'x', attestationObject: 'x' },
};

describe('POST /api/auth/mfa/passkey/register-options — re-auth gate', () => {
  it('returns 400 without password (body or header)', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(testUser.token))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(String(res.body.error)).toMatch(/password|passkey/i);
  });

  it('returns 403 with wrong password in body', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(testUser.token))
      .send({ password: 'WrongPassword1!' });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 403 with wrong password in x-confirm-password header', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(testUser.token))
      .set('x-confirm-password', 'WrongPassword1!')
      .send({});

    expect(res.status).toBe(403);
  });

  it('passes the re-auth gate with the correct password (body)', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(testUser.token))
      .send({ password: 'TestPass123!' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('options');
    expect(res.body).toHaveProperty('challengeToken');
  });

  it('passes the re-auth gate with the correct password (header)', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(testUser.token))
      .set('x-confirm-password', 'TestPass123!')
      .send({});

    expect(res.status).toBe(200);
  });

  it('rejects SSO-only user without mfaCode', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(mfaOnlyUser.token))
      .send({});

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/MFA|password/i);
  });

  it('accepts SSO-only user with valid mfaCode', async () => {
    const code = otplib.generateSync({ secret: mfaTotpSecret });
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(mfaOnlyUser.token))
      .send({ mfaCode: code });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('challengeToken');
  });

  it('rejects SSO-only user with wrong mfaCode', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-options')
      .set('Authorization', authHeader(mfaOnlyUser.token))
      .send({ mfaCode: '000000' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/mfa/passkey/register-verify — re-auth gate', () => {
  it('returns 400 without password', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-verify')
      .set('Authorization', authHeader(testUser.token))
      .send({ challengeToken: 'dummy', credential: invalidCredential });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/password|passkey/i);
  });

  it('returns 403 with wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-verify')
      .set('Authorization', authHeader(testUser.token))
      .send({ challengeToken: 'dummy', credential: invalidCredential, password: 'WrongPass1!' });

    expect(res.status).toBe(403);
  });

  // With a correct password the request passes the re-auth gate and fails
  // later inside the try/catch on the invalid challengeToken / credential.
  // We assert the error is NOT the re-auth error.
  it('passes the re-auth gate with the correct password (fails later on invalid challenge)', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-verify')
      .set('Authorization', authHeader(testUser.token))
      .send({ challengeToken: 'invalid.jwt.value', credential: invalidCredential, password: 'TestPass123!' });

    expect(res.status).not.toBe(403);
    expect(String(res.body.error ?? '')).not.toMatch(/incorrect password/i);
  });
});

describe('POST /api/auth/mfa/passkey/register-session — re-auth gate (browser flow entry point)', () => {
  it('returns 400 without password', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-session')
      .set('Authorization', authHeader(testUser.token))
      .send({});

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/password|passkey/i);
  });

  it('returns 403 with wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-session')
      .set('Authorization', authHeader(testUser.token))
      .send({ password: 'WrongPass1!' });

    expect(res.status).toBe(403);
  });

  it('issues a sessionToken with the correct password', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/passkey/register-session')
      .set('Authorization', authHeader(testUser.token))
      .send({ password: 'TestPass123!' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sessionToken');
    expect(typeof res.body.sessionToken).toBe('string');
  });
});
