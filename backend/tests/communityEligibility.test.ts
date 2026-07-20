// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * evaluateCommunityEligibility — owner resolution + MFA-factor tests.
 *
 * Regression coverage for the official-server checklist bug (2026-07-20):
 * the evaluator resolved the owner through the mutable `ServerMember.role`
 * display string, which the 20260713 add_server_owner_id migration
 * deprecated as an ownership source. Owners whose display string drifted
 * from the literal 'owner' showed the owner email/MFA checks as unmet
 * regardless of their real account state. The MFA check also only read the
 * `mfaEnabled` flag, missing owners whose factor rows (passkey/TOTP)
 * predate the flag write.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { prisma } from '../src/db.js';
import { evaluateCommunityEligibility, type EligibilityResult, type EligibilityCheckKey } from '../src/utils/communityEligibility.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';

afterAll(async () => { await cleanupTestData(); });

function check(result: EligibilityResult, key: EligibilityCheckKey) {
  const c = result.checks.find((entry) => entry.key === key);
  if (!c) throw new Error(`check ${key} missing from result`);
  return c;
}

describe('evaluateCommunityEligibility — owner resolution', () => {
  it('resolves the owner via authoritative Server.ownerId even when the member role string drifted', async () => {
    const owner = await createTestUser();
    await prisma.user.update({ where: { id: owner.id }, data: { mfaEnabled: true } });
    const server = await createTestServer(owner.id);

    // Drifted display string (e.g. mirrored from a renamed role) — ownership
    // is still authoritative via Server.ownerId.
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: owner.id, serverId: server.id } },
      data: { role: 'Founder' },
    });

    const result = await evaluateCommunityEligibility(server.id);
    expect(check(result, 'owner_email_verified').met).toBe(true);
    expect(check(result, 'owner_mfa_enabled').met).toBe(true);
  });

  it('falls back to the legacy owner role string when Server.ownerId is null', async () => {
    const owner = await createTestUser();
    await prisma.user.update({ where: { id: owner.id }, data: { mfaEnabled: true } });
    const server = await createTestServer(owner.id);

    // Pre-migration shape: no authoritative column, only the role string.
    await prisma.server.update({ where: { id: server.id }, data: { ownerId: null } });

    const result = await evaluateCommunityEligibility(server.id);
    expect(check(result, 'owner_email_verified').met).toBe(true);
    expect(check(result, 'owner_mfa_enabled').met).toBe(true);
  });

  it('fails both owner checks when no owner is resolvable at all', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.server.update({ where: { id: server.id }, data: { ownerId: null } });
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: owner.id, serverId: server.id } },
      data: { role: 'member' },
    });

    const result = await evaluateCommunityEligibility(server.id);
    expect(check(result, 'owner_email_verified').met).toBe(false);
    expect(check(result, 'owner_mfa_enabled').met).toBe(false);
  });
});

describe('evaluateCommunityEligibility — owner MFA factors', () => {
  it('treats a passkey-only owner as having MFA even when the mfaEnabled flag is stale-false', async () => {
    const owner = await createTestUser();
    // Legacy enrollment shape: a passkey row exists but the mfaEnabled flag
    // write never happened (predates the flag write on the passkey path).
    await prisma.passkeyCredential.create({
      data: { userId: owner.id, credentialId: randomUUID(), publicKey: 'test-public-key' },
    });
    const server = await createTestServer(owner.id);

    const result = await evaluateCommunityEligibility(server.id);
    expect(check(result, 'owner_mfa_enabled').met).toBe(true);
  });

  it('treats a TOTP-enrolled owner as having MFA even when the mfaEnabled flag is stale-false', async () => {
    const owner = await createTestUser();
    await prisma.user.update({
      where: { id: owner.id },
      data: { mfaEnabled: false, mfaTotpSecret: 'encrypted-test-secret' },
    });
    const server = await createTestServer(owner.id);

    const result = await evaluateCommunityEligibility(server.id);
    expect(check(result, 'owner_mfa_enabled').met).toBe(true);
  });

  it('keeps owner_mfa_enabled unmet when no factor exists', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);

    const result = await evaluateCommunityEligibility(server.id);
    expect(check(result, 'owner_mfa_enabled').met).toBe(false);
  });
});
