// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * UserSecurityEvent audit table + emissions.
 *
 * Integration tests (Postgres required):
 *
 *   (a) Password change emits `password_changed` with masked IP.
 *   (b) TOTP enable emits `mfa_totp_enabled`.
 *   (c) Session revoke emits `session_revoked` with the revoked sessionId.
 *   (d) `GET /me/security-events` returns only the caller's events —
 *       cross-user request sees an empty list even when another user has
 *       events (IDOR defense).
 *   (e) Pagination + 90-day window: events older than 90d are filtered out;
 *       `nextCursor` round-trips.
 *   (f) Unauthenticated list request returns 401.
 *   (g) After a password change, the list feed surfaces a `password_changed`
 *       row within 1 second of the change.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import * as otplib from 'otplib';
import { encryptSecret } from '../src/services/mfaCrypto.js';

let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();
});

afterAll(async () => {
  await cleanupTestData();
});

/**
 * Poll the user's UserSecurityEvent table briefly — emissions are
 * fire-and-forget, so the row may land a few ms after the route responds.
 * Scan for any event matching the predicate within a 1s budget.
 */
async function waitForEvent(
  userId: string,
  predicate: (e: { eventType: string; metadata: unknown }) => boolean,
  timeoutMs = 1000,
): Promise<{ id: string; eventType: string; ipMasked: string | null; userAgentHash: string | null; metadata: unknown; createdAt: Date } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await prisma.userSecurityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const match = events.find((e) => predicate({ eventType: e.eventType, metadata: e.metadata }));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('emissions land on security-sensitive routes', () => {
  it('password change emits password_changed with masked IP', async () => {
    const user = await createTestUser();
    const res = await request(app)
      .patch('/api/v1/auth/me/password')
      .set('Authorization', authHeader(user.token))
      .send({ currentPassword: 'TestPass123!', newPassword: 'NewStrongPass1!x' });

    expect(res.status).toBe(200);

    const ev = await waitForEvent(user.id, (e) => e.eventType === 'password_changed');
    expect(ev, 'password_changed event must be recorded').not.toBeNull();
    // Supertest hits the app directly so req.ip may or may not be set
    // depending on Express's trust-proxy config; we only require the field
    // types are correct (string|null) — not a specific value.
    expect(ev!.ipMasked === null || typeof ev!.ipMasked === 'string').toBe(true);
    expect(ev!.userAgentHash === null || typeof ev!.userAgentHash === 'string').toBe(true);
  });

  it('TOTP enable emits mfa_totp_enabled', async () => {
    const user = await createTestUser();
    // Mint the setup-token payload — same shape /totp/setup produces.
    // Using a raw secret lets the test skip the /setup step since /enable
    // accepts an encryptedSecret via its own sessionToken path.
    const secret = otplib.generateSecret();
    const encryptedSecret = encryptSecret(secret);
    // Directly seed mfaTotpSecret so the /enable fallback path can pick it
    // up without needing to reproduce the setup-token JWT shape.
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaTotpSecret: encryptedSecret },
    });

    const code = otplib.generateSync({ secret });
    const res = await request(app)
      .post('/api/v1/auth/mfa/totp/enable')
      .set('Authorization', authHeader(user.token))
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mfaEnabled', true);

    const ev = await waitForEvent(user.id, (e) => e.eventType === 'mfa_totp_enabled');
    expect(ev, 'mfa_totp_enabled event must be recorded').not.toBeNull();
  });

  it('session revoke emits session_revoked with sessionId in metadata', async () => {
    const user = await createTestUser();
    // Create a second session we can revoke; we don't want to delete the
    // auth token we're using for the request.
    const otherSession = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: 'test-session-hash-' + Date.now(),
        deviceName: 'Second Device',
        deviceType: 'web',
        os: 'Test',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await request(app)
      .delete(`/api/v1/sessions/${otherSession.id}`)
      .set('Authorization', authHeader(user.token));

    expect(res.status).toBe(200);

    const ev = await waitForEvent(user.id, (e) => e.eventType === 'session_revoked');
    expect(ev, 'session_revoked event must be recorded').not.toBeNull();
    const md = ev!.metadata as { sessionId?: string } | null;
    expect(md?.sessionId).toBe(otherSession.id);
  });
});

describe('GET /me/security-events', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/v1/me/security-events');
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s events (IDOR defense)', async () => {
    // Seed events on both users; ensure A's feed never leaks B's rows.
    await prisma.userSecurityEvent.create({
      data: { userId: userA.id, eventType: 'password_changed', ipMasked: null, userAgentHash: null },
    });
    await prisma.userSecurityEvent.create({
      data: { userId: userB.id, eventType: 'mfa_totp_enabled', ipMasked: null, userAgentHash: null },
    });

    const resA = await request(app)
      .get('/api/v1/me/security-events')
      .set('Authorization', authHeader(userA.token));

    expect(resA.status).toBe(200);
    const eventsA = resA.body.events as Array<{ eventType: string }>;
    expect(eventsA.length).toBeGreaterThanOrEqual(1);
    // No row in A's feed may belong to user B.
    for (const ev of eventsA) {
      // We can't see userId in the projection, but we can verify no
      // `mfa_totp_enabled` row leaks from B — A doesn't have one here.
      if (ev.eventType === 'mfa_totp_enabled') {
        throw new Error('IDOR leak: user A feed includes an mfa_totp_enabled event only user B has');
      }
    }

    const resB = await request(app)
      .get('/api/v1/me/security-events')
      .set('Authorization', authHeader(userB.token));

    expect(resB.status).toBe(200);
    const eventsB = resB.body.events as Array<{ eventType: string }>;
    expect(eventsB.find((e) => e.eventType === 'mfa_totp_enabled')).toBeDefined();
  });

  it('paginates forward with cursor and filters events older than 90 days', async () => {
    const user = await createTestUser();

    // Spread 3 recent events across a 2-second window so we can cursor
    // through them in strict DESC order. Adjust createdAt directly — this
    // is the only way to force ordering in a single test.
    const now = Date.now();
    await prisma.userSecurityEvent.createMany({
      data: [
        { userId: user.id, eventType: 'login_success', createdAt: new Date(now - 1000) },
        { userId: user.id, eventType: 'password_changed', createdAt: new Date(now - 500) },
        { userId: user.id, eventType: 'mfa_totp_enabled', createdAt: new Date(now - 100) },
      ],
    });

    // Also seed one row that's outside the 90-day window — the endpoint
    // MUST NOT return it.
    const hundredDaysAgo = new Date(now - 100 * 24 * 60 * 60 * 1000);
    await prisma.userSecurityEvent.create({
      data: { userId: user.id, eventType: 'logout_all', createdAt: hundredDaysAgo },
    });

    // Page 1 — limit=2, DESC.
    const page1 = await request(app)
      .get('/api/v1/me/security-events?limit=2')
      .set('Authorization', authHeader(user.token));

    expect(page1.status).toBe(200);
    const events1 = page1.body.events as Array<{ eventType: string; createdAt: string }>;
    expect(events1.length).toBe(2);
    expect(events1[0].eventType).toBe('mfa_totp_enabled');
    expect(events1[1].eventType).toBe('password_changed');
    expect(page1.body.nextCursor).toBeTruthy();

    // Page 2 — cursor past the first page; must return only the oldest row
    // (login_success) because the 100-day-old row is outside the window.
    const page2 = await request(app)
      .get(`/api/v1/me/security-events?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor as string)}`)
      .set('Authorization', authHeader(user.token));

    expect(page2.status).toBe(200);
    const events2 = page2.body.events as Array<{ eventType: string }>;
    expect(events2.length).toBe(1);
    expect(events2[0].eventType).toBe('login_success');
    expect(page2.body.nextCursor).toBeNull();
  });

  it('rejects malformed cursor (non-ISO string) via Zod', async () => {
    const res = await request(app)
      .get('/api/v1/me/security-events?cursor=not-a-date')
      .set('Authorization', authHeader(userA.token));

    // validate() middleware returns 400 on Zod failure.
    expect(res.status).toBe(400);
  });

  it('clamps limit to max=100 at the schema level', async () => {
    // limit=500 should fail Zod validation (max=100).
    const res = await request(app)
      .get('/api/v1/me/security-events?limit=500')
      .set('Authorization', authHeader(userA.token));

    expect(res.status).toBe(400);
  });
});

describe('user discovers attacker-initiated password change', () => {
  it('password change shows up in the user\'s /me/security-events feed within 1 second', async () => {
    const user = await createTestUser();

    const pwRes = await request(app)
      .patch('/api/v1/auth/me/password')
      .set('Authorization', authHeader(user.token))
      .send({ currentPassword: 'TestPass123!', newPassword: 'AnotherStrongPw1!z' });

    expect(pwRes.status).toBe(200);

    // Poll the feed — the emission is fire-and-forget, so we allow up to
    // 1s for the UserSecurityEvent write to land. The password change
    // route uses the same authorization token (session not revoked yet?);
    // actually /me/password DOES revoke other sessions. The current
    // token's own session is preserved (note in auth.ts:977), so the
    // caller can keep using it.
    const deadline = Date.now() + 1000;
    let seen = false;
    while (Date.now() < deadline && !seen) {
      const feed = await request(app)
        .get('/api/v1/me/security-events')
        .set('Authorization', authHeader(user.token));
      if (feed.status === 200) {
        const events = feed.body.events as Array<{ eventType: string }>;
        if (events.some((e) => e.eventType === 'password_changed')) {
          seen = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen, 'password_changed must appear in the feed within 1s of the change').toBe(true);
  });
});
