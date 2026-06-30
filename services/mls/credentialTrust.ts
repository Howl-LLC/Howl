// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { CiphersuiteImpl } from 'ts-mls';
import { decodeKeyPackage, verifyKeyPackage } from 'ts-mls/keyPackage.js';
import { decodeMlsCredentialIdentity, buildDeviceXsigMessage } from './mlsIdentity';

export interface LeafVerifyResult {
  ok: boolean;
  userId: string | null;
  aikPub: Uint8Array | null;
  reason?: 'parse' | 'crosssig' | 'userid_mismatch';
}

/**
 * Decode a v2 basic-credential identity and verify its AIK cross-signature over
 * the leaf's signing key. Pure: returns the embedded aikPub for the caller to
 * pin/verify against the trust store. Fails closed.
 */
export async function verifyLeafCredential(params: {
  credentialIdentity: Uint8Array;
  leafSigningPublicKey: Uint8Array;
  impl: CiphersuiteImpl;
  expectedUserId?: string;
}): Promise<LeafVerifyResult> {
  const { credentialIdentity, leafSigningPublicKey, impl, expectedUserId } = params;
  let dec: ReturnType<typeof decodeMlsCredentialIdentity>;
  try {
    dec = decodeMlsCredentialIdentity(credentialIdentity);
  } catch {
    return { ok: false, userId: null, aikPub: null, reason: 'parse' };
  }
  if (expectedUserId !== undefined && dec.userId !== expectedUserId) {
    return { ok: false, userId: dec.userId, aikPub: dec.aikPub, reason: 'userid_mismatch' };
  }
  const msg = buildDeviceXsigMessage(dec.userId, dec.deviceId, leafSigningPublicKey);
  let xsigOk: boolean;
  try {
    xsigOk = await impl.signature.verify(dec.aikPub, msg, dec.crossSig);
  } catch {
    xsigOk = false;
  }
  if (!xsigOk) return { ok: false, userId: dec.userId, aikPub: dec.aikPub, reason: 'crosssig' };
  return { ok: true, userId: dec.userId, aikPub: dec.aikPub };
}

export class KeyPackageUntrustedError extends Error {
  constructor(public readonly userId: string, public readonly reason: string) {
    super(`KeyPackage for ${userId} failed trust check: ${reason}`);
    this.name = 'KeyPackageUntrustedError';
  }
}

/**
 * Decode a consumed KeyPackage and assert: basic credential, valid self-signature,
 * valid AIK cross-sig over the leaf key, credential userId == requested userId, and
 * the AIK TOFU-pins or matches the trust store. Throws (fail closed) on any miss.
 */
export async function assertConsumedKeyPackageTrusted(
  keyPackageBytes: Uint8Array,
  requestedUserId: string,
  impl: CiphersuiteImpl,
  pinOrVerify: (userId: string, aikPub: Uint8Array, device?: { deviceId: string; leafKey: Uint8Array }) => Promise<boolean>,
  copy: (b: Uint8Array) => Uint8Array,
): Promise<void> {
  const decoded = decodeKeyPackage(copy(keyPackageBytes), 0);
  if (!decoded) throw new KeyPackageUntrustedError(requestedUserId, 'malformed');
  const kp = decoded[0];
  const cred = kp.leafNode.credential;
  if (cred.credentialType !== 'basic') throw new KeyPackageUntrustedError(requestedUserId, 'non_basic');
  let selfOk: boolean;
  try { selfOk = await verifyKeyPackage(kp, impl.signature); } catch { selfOk = false; }
  if (!selfOk) throw new KeyPackageUntrustedError(requestedUserId, 'bad_signature');
  const r = await verifyLeafCredential({
    credentialIdentity: cred.identity,
    leafSigningPublicKey: kp.leafNode.signaturePublicKey,
    impl,
    expectedUserId: requestedUserId,
  });
  if (!r.ok || !r.userId || !r.aikPub) throw new KeyPackageUntrustedError(requestedUserId, r.reason ?? 'verify');
  const trusted = await pinOrVerify(requestedUserId, r.aikPub, {
    deviceId: '', leafKey: kp.leafNode.signaturePublicKey,
  });
  if (!trusted) throw new KeyPackageUntrustedError(requestedUserId, 'aik_mismatch');
}
