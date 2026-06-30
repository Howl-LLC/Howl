// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateKeyPackageWithKey, defaultCapabilities, type Credential, type Lifetime } from 'ts-mls';
import { encodeKeyPackage } from 'ts-mls/keyPackage.js'; // not barrel-exported
import { getImpl } from '../../src/mls/ciphersuite.js';
import { encodeMlsIdentity, buildDeviceXsigMessage } from '../../src/mls/credential.js';
import { bufToB64 } from '../../src/mls/serialization.js';
import { validateAndBindKeyPackage } from '../../src/mls/as.js';
import { HarnessClient } from './harnessClient.js';

const realLifetime = (): Lifetime => ({
  notBefore: 0n,
  notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30), // 30 days
});

/**
 * Hand-roll a v2 KeyPackage with a REAL leaf signing key and an explicit
 * (aikPub, crossSig) pair so the negative cross-sig cases can craft an embedded
 * AIK that matches the published AIK while the cross-sig is forged. The cross-sig
 * is signed by `xsigSignKey` over buildDeviceXsigMessage(userId, deviceId, leafPub);
 * pass a DIFFERENT signing key than `aikPub`'s private half to produce a
 * bad_crosssig package.
 */
async function makeKpRaw(opts: {
  userId: string;
  deviceId: string;
  aikPub: Uint8Array;
  xsigSignKey: Uint8Array;
  lifetime?: Lifetime;
}): Promise<string> {
  const impl = await getImpl();
  const leaf = await impl.signature.keygen();
  const crossSig = await impl.signature.sign(opts.xsigSignKey, buildDeviceXsigMessage(opts.userId, opts.deviceId, leaf.publicKey));
  const credential: Credential = {
    credentialType: 'basic',
    identity: encodeMlsIdentity(opts.userId, opts.deviceId, opts.aikPub, crossSig),
  };
  const { publicPackage } = await generateKeyPackageWithKey(
    credential,
    defaultCapabilities(),
    opts.lifetime ?? realLifetime(),
    [],
    leaf,
    impl,
  );
  return bufToB64(encodeKeyPackage(publicPackage));
}

describe('validateAndBindKeyPackage', () => {
  it('accepts a well-formed, correctly cross-signed KeyPackage whose identity + AIK match', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const client = await HarnessClient.create(userId, deviceId);
    const kpB64 = await client.publishKeyPackageB64();
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, client.aikPublicKeyB64());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.keyPackageRef).toBe('string');
      expect(result.keyPackageRef.length).toBeGreaterThan(0);
      expect(result.notAfter).toBeInstanceOf(Date);
    }
  });

  it('rejects when no publisher AIK is on file (no_aik)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const client = await HarnessClient.create(userId, deviceId);
    const kpB64 = await client.publishKeyPackageB64();
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, null);
    expect(result).toMatchObject({ ok: false, reason: 'no_aik' });
  });

  it('rejects when the embedded AIK does not match the published account AIK (aik_mismatch)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const client = await HarnessClient.create(userId, deviceId);
    const kpB64 = await client.publishKeyPackageB64();
    // A different account AIK on file → the credential's embedded AIK can't match it.
    const otherAik = bufToB64((await (await getImpl()).signature.keygen()).publicKey);
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, otherAik);
    expect(result).toMatchObject({ ok: false, reason: 'aik_mismatch' });
  });

  it('rejects when the cross-sig was made by a different AIK than the one published (bad_crosssig)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const impl = await getImpl();
    const aik = await impl.signature.keygen();        // the account AIK (its pub is published + embedded)
    const forger = await impl.signature.keygen();     // a DIFFERENT key that actually signs the cross-sig
    // Embedded AIK == published AIK (so we pass aik_mismatch) but the cross-sig is
    // forged by `forger` → must fail the Ed25519 verify under `aik`.
    const kpB64 = await makeKpRaw({ userId, deviceId, aikPub: aik.publicKey, xsigSignKey: forger.signKey });
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, bufToB64(aik.publicKey));
    expect(result).toMatchObject({ ok: false, reason: 'bad_crosssig' });
  });

  it('rejects when the credential identity does not match the authenticated user', async () => {
    const client = await HarnessClient.create(randomUUID(), randomUUID());
    const kpB64 = await client.publishKeyPackageB64();
    const result = await validateAndBindKeyPackage(kpB64, randomUUID(), randomUUID(), client.aikPublicKeyB64());
    expect(result).toMatchObject({ ok: false, reason: 'identity_mismatch' });
  });

  it('rejects garbage / non-decodable bytes', async () => {
    const result = await validateAndBindKeyPackage(bufToB64(Buffer.from([1, 2, 3])), randomUUID(), randomUUID(), null);
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('clamps an over-long lifetime to the server max (notAfter capped)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const impl = await getImpl();
    const aik = await impl.signature.keygen();
    const tenYears: Lifetime = { notBefore: 0n, notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3650) };
    const kpB64 = await makeKpRaw({ userId, deviceId, aikPub: aik.publicKey, xsigSignKey: aik.signKey, lifetime: tenYears });
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, bufToB64(aik.publicKey), false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const maxMs = Date.now() + 1000 * 60 * 60 * 24 * 31; // 31-day ceiling + slack
      expect(result.notAfter.getTime()).toBeLessThanOrEqual(maxMs);
    }
  });

  it('clamps a single-use KeyPackage to the 30-day ceiling (isLastResort=false)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const impl = await getImpl();
    const aik = await impl.signature.keygen();
    const tenYears: Lifetime = { notBefore: 0n, notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3650) };
    const kpB64 = await makeKpRaw({ userId, deviceId, aikPub: aik.publicKey, xsigSignKey: aik.signKey, lifetime: tenYears });
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, bufToB64(aik.publicKey), false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const maxMs = Date.now() + 1000 * 60 * 60 * 24 * 31; // 31-day ceiling + slack
      expect(result.notAfter.getTime()).toBeLessThanOrEqual(maxMs);
    }
  });

  it('clamps a last-resort declared > 100yr to a valid FINITE Date (isLastResort=true)', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const impl = await getImpl();
    const aik = await impl.signature.keygen();
    const twoHundredYears: Lifetime = {
      notBefore: 0n,
      notAfter: BigInt(Math.floor(Date.now() / 1000) + 200 * 365 * 24 * 60 * 60),
    };
    const kpB64 = await makeKpRaw({ userId, deviceId, aikPub: aik.publicKey, xsigSignKey: aik.signKey, lifetime: twoHundredYears });
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, bufToB64(aik.publicKey), true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Number.isNaN(result.notAfter.getTime())).toBe(false); // NOT Invalid Date
      const ceilingMs = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;
      expect(result.notAfter.getTime()).toBeLessThanOrEqual(ceilingMs + 60_000);
      expect(result.notAfter.getTime()).toBeGreaterThan(Date.now() + 1000 * 60 * 60 * 24 * 365);
    }
  });

  it('clamps a last-resort declared < 100yr to its own (shorter) declared notAfter', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const impl = await getImpl();
    const aik = await impl.signature.keygen();
    const tenYears: Lifetime = { notBefore: 0n, notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3650) };
    const kpB64 = await makeKpRaw({ userId, deviceId, aikPub: aik.publicKey, xsigSignKey: aik.signKey, lifetime: tenYears });
    const result = await validateAndBindKeyPackage(kpB64, userId, deviceId, bufToB64(aik.publicKey), true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const elevenYearsMs = Date.now() + 11 * 365 * 24 * 60 * 60 * 1000;
      expect(result.notAfter.getTime()).toBeLessThanOrEqual(elevenYearsMs);
      expect(result.notAfter.getTime()).toBeGreaterThan(Date.now() + 1000 * 60 * 60 * 24 * 365);
    }
  });
});
