// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// X-Wing (codepoint 83) worst-case MLS payload-size MEASUREMENT + regression guard.
//
// The PQC suite flip (X25519 -> X-Wing KEM) blows up every artifact that embeds a
// KEM public key or ciphertext: KeyPackages, the ratchet tree inside GroupInfo, the
// Add commit, and the Welcome. This test builds the production WORST CASE — a single
// batched commit that Adds the 14 other members of a 15-member group (the
// MAX_GROUP_DM_MEMBERS ceiling, backend/src/routes/dms.ts) — through the REAL
// services/mls/mlsEngine.ts, assembles the exact REST submit-commit body the
// coordinator sends (services/mls/mlsCoordinatorCore.ts), and pins the resulting
// sizes UNDER the three transport caps so a future size regression fails CI here.
//
// ts-mls's default crypto provider needs WebCrypto; jsdom lacks it, so install
// Node's webcrypto polyfill (mirrors __tests__/mls/mlsEngine.test.ts).
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { generateKeyPackage, defaultCapabilities, type Credential, type Lifetime } from 'ts-mls';
import { encodeKeyPackage, makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../services/mls/ciphersuite';
import { toBase64 } from '../../services/cryptoHelpers';
import { buildCrossSignedCredentialIdentity } from '../../services/mls/mlsIdentity';
import {
  createGroup,
  addMembers,
  currentEpoch,
  makeGroupInfo,
  type MlsIdentity,
  type KeyPackageCandidate,
} from '../../services/mls/mlsEngine';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Transport caps under test (single source: the backend)
// Each constant mirrors a real backend cap; the assertions below prove the
// measured X-Wing worst case fits under it WITH headroom. If the suite or ts-mls
// grows the artifacts past these bounds, this test fails BEFORE the bytes ever
// hit the wire and get silently rejected at the cap.
//
//  - JSON_LIMIT_BYTES      : Express route-scoped JSON body cap for the MLS group
//                            routes (app.use('/api/v1/mls/groups', express.json({ limit: '2mb' })),
//                            backend/src/server.ts), NOT the 256kb global cap.
//                            The whole submit-commit REST body must fit here.
//  - MLS_BYTES_MAX         : per-field base64 cap (mlsBytes .max), backend/src/schemas.ts.
//                            Bounds each single field: commit / groupInfo / each welcomeData
//                            / KeyPackage. (MLS bytes ride REST, never an inbound socket
//                            cap; the outbound mls-commit relay is bounded by the client
//                            receive buffer, not a server cap.)
const JSON_LIMIT_BYTES = 2 * 1024 * 1024; // server.ts: route-scoped '2mb' JSON parser on /mls/groups (per-recipient-duplicated Welcome body)
const MLS_BYTES_MAX = 262_144; // schemas.ts: mlsBytes .max(262144) (unchanged; holds the largest single X-Wing field)

// Measured X-Wing 15-member worst case (see XWING_PAYLOAD_SIZES log below), pinned
// here so a size regression that still fits the caps but creeps upward is caught:
//   commitB64 ~51.9KB, groupInfoB64 ~31.5KB, welcomeB64 ~53.7KB, submitBody ~837KB.
// Bounds set ~25-30% above the measured value (well under each transport cap).
const COMMIT_B64_BOUND = 70_000; // > ~51.9KB measured, < 256KB mlsBytes field cap
const GROUP_INFO_B64_BOUND = 45_000; // > ~31.5KB measured, < 256KB field cap
const WELCOME_B64_BOUND = 75_000; // > ~53.7KB measured, < 256KB field cap
const KEY_PACKAGE_B64_BOUND = 6_000; // > ~3.7KB measured, < 256KB field cap
const SUBMIT_BODY_BOUND = 1_100_000; // > ~837KB measured, < 2MB body cap

const realLifetime = (): Lifetime => ({
  notBefore: 0n,
  notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30),
});

// Ephemeral test AIK (Ed25519). The v2 credential is 169 bytes (vs the old colon
// string) — measured into the worst-case sizes below; the bounds keep ample headroom.
const testAik = nacl.sign.keyPair();
const v2Identity = (userId: string, deviceId: string): Uint8Array =>
  buildCrossSignedCredentialIdentity(userId, deviceId, testAik.publicKey, testAik.publicKey, testAik.secretKey);

/** Mint a stable signing identity (mirrors mlsEngine.test.ts makeIdentity). */
async function makeIdentity(userId: string, deviceId: string): Promise<MlsIdentity> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: v2Identity(userId, deviceId),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential,
    defaultCapabilities(),
    realLifetime(),
    [],
    impl,
  );
  return {
    signaturePublicKey: publicPackage.leafNode.signaturePublicKey,
    signaturePrivateKey: privatePackage.signaturePrivateKey,
    credentialIdentity: credential.identity,
  };
}

/** A member's published KeyPackage + a userId, mirroring mlsEngine.test.ts makeCandidate. */
async function makeMember(): Promise<{ userId: string; candidate: KeyPackageCandidate }> {
  const impl = await getImpl();
  const userId = randomUUID();
  const credential: Credential = {
    credentialType: 'basic',
    identity: v2Identity(userId, randomUUID()),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential,
    defaultCapabilities(),
    realLifetime(),
    [],
    impl,
  );
  const keyPackageBytes = encodeKeyPackage(publicPackage);
  const ref = await makeKeyPackageRef(publicPackage, impl.hash);
  const privateKeyPackage = new TextEncoder().encode(
    JSON.stringify({
      initPrivateKey: Buffer.from(privatePackage.initPrivateKey).toString('base64'),
      hpkePrivateKey: Buffer.from(privatePackage.hpkePrivateKey).toString('base64'),
      signaturePrivateKey: Buffer.from(privatePackage.signaturePrivateKey).toString('base64'),
      keyPackage: Buffer.from(keyPackageBytes).toString('base64'),
    }),
  );
  return {
    userId,
    candidate: {
      keyPackageRef: Buffer.from(ref).toString('base64'),
      keyPackage: new Uint8Array(keyPackageBytes),
      privateKeyPackage,
      isLastResort: false,
    },
  };
}

interface PayloadSizes {
  members: number;
  keyPackageB64Max: number;
  commitB64: number;
  groupInfoB64: number;
  welcomeB64Max: number;
  welcomesCountInBody: number;
  submitBodyBytes: number;
}

/**
 * Build the production worst case for a group of `totalMembers` (1 founder + N adds):
 * found a group, mint N members, batch-Add them in ONE commit, then assemble the EXACT
 * REST submit-commit body the coordinator sends. Production duplicates the single shared
 * Welcome blob once PER recipient in the `welcomes` array (mlsCoordinatorCore.ts:615,804),
 * so the body carries N copies of welcomeData — we mirror that faithfully.
 */
async function measure(totalMembers: number): Promise<PayloadSizes> {
  const adds = totalMembers - 1; // founder + N invitees
  const founder = await makeIdentity(randomUUID(), randomUUID());
  const founderState = await createGroup(founder, randomUUID());
  expect(currentEpoch(founderState)).toBe(0n);

  const members: { userId: string; candidate: KeyPackageCandidate }[] = [];
  for (let i = 0; i < adds; i++) members.push(await makeMember());

  // The real engine: ONE batched Add commit + ONE shared Welcome + the new GroupInfo.
  const { commit, welcome, newState } = await addMembers(
    founderState,
    members.map((m) => new Uint8Array(m.candidate.keyPackage)),
  );
  const newGroupInfo = await makeGroupInfo(newState);

  // Base64 the artifacts exactly as production does (services/cryptoHelpers.toBase64).
  const commitB64 = toBase64(commit);
  const groupInfoB64 = toBase64(newGroupInfo);
  const welcomeB64 = toBase64(welcome); // the ONE shared Welcome blob
  const keyPackageB64Max = Math.max(...members.map((m) => toBase64(m.candidate.keyPackage).length));

  // The EXACT submit-commit body (services/mls/mlsClient.ts submitCommit + the
  // coordinator's welcomes-per-recipient assembly).
  const body = {
    baseEpoch: '0',
    mode: 'member' as const,
    commit: commitB64,
    groupInfo: groupInfoB64,
    idempotencyKey: randomUUID(),
    welcomes: members.map((m) => ({ recipientId: m.userId, welcomeData: welcomeB64 })),
  };
  const submitBodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');

  return {
    members: totalMembers,
    keyPackageB64Max,
    commitB64: commitB64.length,
    groupInfoB64: groupInfoB64.length,
    welcomeB64Max: welcomeB64.length,
    welcomesCountInBody: body.welcomes.length,
    submitBodyBytes,
  };
}

describe('X-Wing MLS worst-case payload sizes (15-member group ceiling)', () => {
  // X-Wing keygen is much heavier than X25519; minting 14 KeyPackages + the batched
  // commit needs well over the default 10s. Give the 15-member case room.
  it('measures the curve at 2 / 8 / 15 members and pins the ceiling under transport caps', async () => {
    const at2 = await measure(2);
    const at8 = await measure(8);
    const at15 = await measure(15); // MAX_GROUP_DM_MEMBERS

    console.log('XWING_PAYLOAD_SIZES', JSON.stringify({ at2, at8, at15 }));

    // The 15-member group is the production worst case (MAX_GROUP_DM_MEMBERS = 15).
    const worst = at15;
    expect(worst.welcomesCountInBody).toBe(14); // 1 founder + 14 invitees, one Welcome entry each

    // Regression bounds pinned just above the measured worst case
    // These trip FIRST (before the cap assertions) so a size regression points at
    // the exact field that grew rather than at a generic over-cap failure.
    expect(worst.commitB64).toBeLessThan(COMMIT_B64_BOUND);
    expect(worst.groupInfoB64).toBeLessThan(GROUP_INFO_B64_BOUND);
    expect(worst.welcomeB64Max).toBeLessThan(WELCOME_B64_BOUND);
    expect(worst.keyPackageB64Max).toBeLessThan(KEY_PACKAGE_B64_BOUND);
    expect(worst.submitBodyBytes).toBeLessThan(SUBMIT_BODY_BOUND);

    // Each artifact must fit the transport cap it actually rides
    expect(worst.submitBodyBytes).toBeLessThan(JSON_LIMIT_BYTES); // REST body must fit (server.ts route-scoped /mls/groups 2mb parser)
    // Every single base64 field passes through the per-field mlsBytes cap (schemas.ts).
    expect(worst.commitB64).toBeLessThan(MLS_BYTES_MAX);
    expect(worst.groupInfoB64).toBeLessThan(MLS_BYTES_MAX);
    expect(worst.welcomeB64Max).toBeLessThan(MLS_BYTES_MAX);
    expect(worst.keyPackageB64Max).toBeLessThan(MLS_BYTES_MAX);

    // Monotonic sanity: artifacts grow with membership (founder-only -> ceiling).
    expect(at8.commitB64).toBeGreaterThan(at2.commitB64);
    expect(worst.commitB64).toBeGreaterThan(at8.commitB64);
    expect(worst.submitBodyBytes).toBeGreaterThan(at8.submitBodyBytes);
  }, 120_000);
});
