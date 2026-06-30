// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/tests/selfHostOnboarding.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { cleanupTestData, uniqueEmail, uniqueUsername } from './helpers.js';
import { prisma } from '../src/db.js';
import bcrypt from 'bcrypt';
import { encryptSecret, hashEmail } from '../src/services/mfaCrypto.js';

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['SELF_HOST', 'REGISTRATION_MODE', 'RESEND_API_KEY']) savedEnv[k] = process.env[k];
  process.env.SELF_HOST = 'true';
  delete process.env.RESEND_API_KEY; // emailVerificationDisabled() => true
});
afterAll(async () => {
  for (const k of ['SELF_HOST', 'REGISTRATION_MODE', 'RESEND_API_KEY']) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  await cleanupTestData();
});

describe('self-host email-free login', () => {
  it('does not force verification for an unverified-email account when email is disabled', async () => {
    const email = uniqueEmail();
    const password = 'StrongPass1!xx';
    await prisma.user.create({
      data: {
        username: uniqueUsername(), discriminator: '0001',
        email: encryptSecret(email), emailHash: hashEmail(email),
        passwordHash: await bcrypt.hash(password, 4),
        emailVerified: false, status: 'offline', dateOfBirth: new Date('2000-01-15'),
      },
    });
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200); // login proceeds past the email gate (no 4xx verification block)
    expect(res.body.requiresVerification).toBeFalsy();
  });
});

describe('self-host registration onboarding', () => {
  it('first registrant on a fresh instance becomes admin and owns a default server', async () => {
    await cleanupTestData(); // zero users
    delete process.env.REGISTRATION_MODE; // default closed under self-host
    const res = await request(app).post('/api/auth/register').send({
      username: uniqueUsername(), email: uniqueEmail(), password: 'StrongPass1!xx',
      dateOfBirth: '1990-01-15', agreedToTerms: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user?.id).toBeTruthy();
    const user = await prisma.user.findUnique({ where: { id: res.body.user.id }, select: { role: true, emailVerified: true } });
    expect(user?.role).toBe('ADMIN');
    expect(user?.emailVerified).toBe(true);
    const ownerMembership = await prisma.serverMember.findFirst({ where: { userId: res.body.user.id, role: 'owner' } });
    expect(ownerMembership).not.toBeNull();
  });

  it('closed mode rejects a second self-registration', async () => {
    // Precondition: at least one user exists (the admin from the previous test).
    const count = await prisma.user.count();
    expect(count).toBeGreaterThan(0);
    delete process.env.REGISTRATION_MODE; // closed
    const res = await request(app).post('/api/auth/register').send({
      username: uniqueUsername(), email: uniqueEmail(), password: 'StrongPass1!xx',
      dateOfBirth: '1990-01-15', agreedToTerms: true,
    });
    expect(res.status).toBe(403);
  });

  it('open mode auto-verifies a non-first registrant and returns a session', async () => {
    process.env.REGISTRATION_MODE = 'open';
    const email = uniqueEmail();
    const res = await request(app).post('/api/auth/register').send({
      username: uniqueUsername(), email, password: 'StrongPass1!xx',
      dateOfBirth: '1990-01-15', agreedToTerms: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.requiresVerification).toBeFalsy();
    const user = await prisma.user.findUnique({ where: { emailHash: hashEmail(email) }, select: { role: true, emailVerified: true } });
    expect(user?.emailVerified).toBe(true);
    expect(user?.role).toBe('USER');
    delete process.env.REGISTRATION_MODE;
  });
});
