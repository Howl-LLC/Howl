// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Community lifecycle + eligibility tests.
 *
 * Most of this file targets endpoints in
 * `backend/src/routes/serverCommunity.ts` which are not yet merged into this
 * worktree. Those are written as `it.todo` so the suite stays green here and
 * lights up the moment those endpoints land.
 *
 * The per-IP server-create rate-limit test below IS landed (server.ts) and
 * runs as a real assertion when a Postgres test DB is reachable.
 *
 * When the community endpoints ship:
 *   - replace `it.todo(...)` with `it(...)` and the body below it.
 *   - keep DM E2E sanctity: these tests must NOT exercise DM paths or read
 *     DMMessage rows.
 */

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import {
  createTestUser,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

afterAll(async () => { await cleanupTestData(); });

describe('Server creation per-IP rate limit', () => {
  it('returns 429 after 20 successful creates from the same IP, even across users', async () => {
    // Use 4 fresh users so the per-user 5/h limit (handled by the second
    // limiter in the chain) doesn't fire first. With 4 users × 5 servers each
    // = 20 successful creates → 21st must trip the per-IP daily cap.
    const users: TestUser[] = [];
    for (let i = 0; i < 4; i++) users.push(await createTestUser());

    let successCount = 0;
    let lastStatus = 0;
    let trippedAt = -1;
    for (let i = 0; i < 25; i++) {
      const u = users[i % users.length];
      const res = await request(app)
        .post('/api/v1/servers')
        .set('Authorization', authHeader(u.token))
        .send({ name: `IP-rate-limit ${i}` });
      lastStatus = res.status;
      if (res.status === 201) {
        successCount++;
      } else if (res.status === 429) {
        trippedAt = i;
        break;
      } else {
        // unexpected (e.g. validation), fail loudly
        throw new Error(`unexpected status ${res.status} on iteration ${i}: ${JSON.stringify(res.body)}`);
      }
    }

    // Per-IP cap is 20/day. Allow some slack: the per-user 5/h limiter could
    // also legitimately trip if rotation isn't perfect, but with 4 users we
    // should hit the IP cap first.
    expect(lastStatus).toBe(429);
    expect(successCount).toBeLessThanOrEqual(20);
    expect(trippedAt).toBeGreaterThan(-1);
  }, 30_000);
});

describe('Community lifecycle', () => {
  // GET /api/v1/servers/:serverId/community/eligibility
  it.todo(
    'eligibility check returns full checklist for a fresh server (all blockers listed)',
    // expect every key in: emailVerified, ownerMfa, rulesChannel, rulesPopulated,
    // verificationLevel, automodSpam, notSuspended.
  );

  it.todo(
    'eligibility check reflects partial state (after owner verifies email + adds rules)',
  );

  // POST /api/v1/servers/:serverId/community/enable
  it.todo(
    'enable rejected with 422 eligibility_failed when checks fail; body lists failed keys',
  );

  it.todo(
    'enable succeeds after all checks pass; sets communityEnabled=true and discoverableSince',
  );

  it.todo(
    'enable writes AuditLog row with action=community_enable',
  );

  it.todo(
    'enable requires manageServer permission (member without perm → 403)',
  );

  // POST /api/v1/servers/:serverId/community/disable
  it.todo(
    'disable clears communityEnabled, discoveryEnabled, and writes audit log community_disable',
  );

  // PATCH /api/v1/servers/:serverId/community
  it.todo(
    'PATCH validates category against fixed enum (rejects unknown category with 400)',
  );

  it.todo(
    'PATCH validates tags: max 5 entries, each 2..32 chars, lowercase, no profanity',
  );

  it.todo(
    'PATCH validates language as ISO 639-1 (rejects "english" / "zz")',
  );

  // `nsfwLevel` does not exist on Server. PATCH does not accept it.

  it.todo(
    'PATCH writes AuditLog row with action=community_update and details containing changed keys',
  );

  // Rate limit
  it.todo(
    'rate limit applies: 30 PATCHes/min per user → 31st returns 429',
  );
});
