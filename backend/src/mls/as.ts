// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { type KeyPackage } from 'ts-mls';
// verify/makeRef/decode are NOT barrel-exported; import from the submodule.
import { decodeKeyPackage, verifyKeyPackage, makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { getImpl, MLS_CIPHERSUITE_NAME } from './ciphersuite.js';
import { decodeMlsIdentity, buildDeviceXsigMessage } from './credential.js';
import { b64ToBuf, bufToB64, copyBytes } from './serialization.js';

/**
 * Server-side maximum KeyPackage lifetime. ts-mls declares but never enforces
 * maximumTotalLifetime, so the AS clamps notAfter at publish. The adder-side
 * createCommit gate hard-rejects an expired KeyPackage; receivers keep
 * validateLifetimeOnReceive=false to avoid clock-skew splits.
 */
export const MLS_KEYPACKAGE_MAX_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Last-resort ceiling: ~100 years, FINITE. A last-resort is meant to be always-available,
 * so the server does not clamp it to 30 days - but the ceiling stays finite so
 * Math.min(declared, ceiling) is always a valid Date and the non-nullable notAfter
 * column (schema.prisma MlsKeyPackage.notAfter) never receives an Invalid Date.
 */
export const MLS_LASTRESORT_MAX_LIFETIME_MS = 1000 * 60 * 60 * 24 * 365 * 100; // ~100 years

export type AsBindResult =
  | { ok: true; keyPackageRef: string; notAfter: Date }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'wrong_suite' | 'wrong_version' | 'identity_mismatch' | 'no_aik' | 'aik_mismatch' | 'bad_crosssig' };

/**
 * Validate a published KeyPackage and bind its credential identity to the
 * authenticated (userId, deviceId). Pure validation — holds no private key.
 *
 * Steps:
 *  1. decode (well-formedness) from a COPIED buffer (move-not-borrow);
 *  2. pin version 'mls10' + the active ciphersuite (codepoint 83) by name (ts-mls only checks the
 *     suite at commit time, so an unpinned wrong-suite KeyPackage poisons a
 *     future adder);
 *  3. verify the self-signature;
 *  4. require credential.identity === encodeMlsIdentity(userId, deviceId);
 *  4b. cross-sig: the credential's embedded AIK must equal the account's
 *      published AIK (publisherSigningPublicKey) AND the cross-sig must verify
 *      (raw Ed25519) over the leaf signing key. Fail closed if no AIK is on file.
 *  5. clamp notAfter to the server ceiling and return it for storage. The
 *     ceiling is conditional: a single-use package clamps to 30 days; a
 *     last-resort clamps to a 100-year FINITE ceiling (always-available,
 *     never an Invalid Date).
 */
export async function validateAndBindKeyPackage(
  keyPackageB64: string,
  userId: string,
  deviceId: string,
  publisherSigningPublicKey: string | null,
  isLastResort = false,
): Promise<AsBindResult> {
  const impl = await getImpl();

  let kp: KeyPackage;
  try {
    const decoded = decodeKeyPackage(copyBytes(b64ToBuf(keyPackageB64)), 0);
    if (!decoded) return { ok: false, reason: 'malformed' };
    kp = decoded[0];
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (kp.version !== 'mls10') return { ok: false, reason: 'wrong_version' };
  if (kp.cipherSuite !== MLS_CIPHERSUITE_NAME) return { ok: false, reason: 'wrong_suite' };

  // The `false` initializer is the value read when verifyKeyPackage throws; the
  // catch needs no reassignment (a redundant one trips no-useless-assignment).
  let signatureOk = false;
  try {
    signatureOk = await verifyKeyPackage(kp, impl.signature);
  } catch {
    /* malformed signature material -> treat as not verified */
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };

  const cred = kp.leafNode.credential;
  if (cred.credentialType !== 'basic') return { ok: false, reason: 'identity_mismatch' };
  let identity: ReturnType<typeof decodeMlsIdentity>;
  try {
    identity = decodeMlsIdentity(cred.identity);
  } catch {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (identity.userId !== userId || identity.deviceId !== deviceId) {
    return { ok: false, reason: 'identity_mismatch' };
  }

  // Cross-sig: the credential's embedded AIK must match the account's published
  // AIK, and the cross-sig must verify (raw Ed25519) over the leaf signing key.
  // Fail closed if no AIK is on file.
  if (!publisherSigningPublicKey) return { ok: false, reason: 'no_aik' };
  if (bufToB64(identity.aikPub) !== publisherSigningPublicKey) return { ok: false, reason: 'aik_mismatch' };
  const xsigMsg = buildDeviceXsigMessage(identity.userId, identity.deviceId, kp.leafNode.signaturePublicKey);
  // The `false` initializer is the value read when verify throws; the catch needs no
  // reassignment (a redundant one trips no-useless-assignment), mirroring the self-sig check above.
  let xsigOk = false;
  try {
    xsigOk = await impl.signature.verify(identity.aikPub, xsigMsg, identity.crossSig);
  } catch {
    /* malformed cross-sig material -> treat as not verified */
  }
  if (!xsigOk) return { ok: false, reason: 'bad_crosssig' };

  // A key_package leaf carries the Lifetime (notAfter is seconds since the Unix
  // epoch, bigint). kp.leafNode is typed LeafNodeKeyPackage, so .lifetime is
  // statically present (no narrowing needed).
  const declaredNotAfterMs = Number(kp.leafNode.lifetime.notAfter) * 1000;
  // Conditional ceiling: single-use clamps to 30d; a last-resort clamps to a
  // 100-year FINITE ceiling (always-available, never int64-max). The server
  // trusts the client-asserted isLastResort for the no-30d-clamp branch,
  // bounded by one-live-last-resort supersede + consume-prefers-single-use.
  const ceilingMs = Date.now() + (isLastResort ? MLS_LASTRESORT_MAX_LIFETIME_MS : MLS_KEYPACKAGE_MAX_LIFETIME_MS);
  const notAfter = new Date(Math.min(declaredNotAfterMs, ceilingMs));

  const ref = await makeKeyPackageRef(kp, impl.hash);
  return { ok: true, keyPackageRef: bufToB64(ref), notAfter };
}
