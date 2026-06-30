// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getImpl } from '../../src/mls/ciphersuite.js';
import { encodeMlsIdentity, decodeMlsIdentity } from '../../src/mls/credential.js';
import { b64ToBuf, bufToB64, copyBytes } from '../../src/mls/serialization.js';

describe('mls/ciphersuite', () => {
  it('memoizes one CiphersuiteImpl for suite id 83', async () => {
    const a = await getImpl();
    const b = await getImpl();
    expect(a).toBe(b); // same instance — memoized
    expect(a.name).toBe('MLS_256_XWING_AES256GCM_SHA512_Ed25519');
  });
});

describe('mls/credential', () => {
  const aikPub = new Uint8Array(32).fill(5);
  const crossSig = new Uint8Array(64).fill(8);

  it('round-trips the v2 versioned credential identity (169 bytes)', () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const bytes = encodeMlsIdentity(userId, deviceId, aikPub, crossSig);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(169);
    const dec = decodeMlsIdentity(bytes);
    expect(dec.version).toBe(2);
    expect(dec.userId).toBe(userId);
    expect(dec.deviceId).toBe(deviceId);
    expect(Array.from(dec.aikPub)).toEqual(Array.from(aikPub));
    expect(Array.from(dec.crossSig)).toEqual(Array.from(crossSig));
  });

  it('encode rejects non-UUID ids and wrong-length AIK/crossSig', () => {
    expect(() => encodeMlsIdentity('not-a-uuid', randomUUID(), aikPub, crossSig)).toThrow();
    expect(() => encodeMlsIdentity(randomUUID(), 'x', aikPub, crossSig)).toThrow();
    expect(() => encodeMlsIdentity(randomUUID(), randomUUID(), new Uint8Array(16), crossSig)).toThrow();
    expect(() => encodeMlsIdentity(randomUUID(), randomUUID(), aikPub, new Uint8Array(32))).toThrow();
  });

  it('decode fails closed on wrong length and wrong version', () => {
    expect(() => decodeMlsIdentity(new Uint8Array(10))).toThrow();
    expect(() => decodeMlsIdentity(new TextEncoder().encode('not-a-uuid'))).toThrow();
    const bytes = encodeMlsIdentity(randomUUID(), randomUUID(), aikPub, crossSig);
    bytes[0] = 0x01; // wrong version
    expect(() => decodeMlsIdentity(bytes)).toThrow();
  });
});

describe('mls/serialization', () => {
  it('round-trips base64 <-> Buffer', () => {
    const buf = Buffer.from([0, 1, 254, 255]);
    expect(b64ToBuf(bufToB64(buf))).toEqual(buf);
  });

  it('copyBytes returns a fresh buffer that does not alias the input', () => {
    const src = new Uint8Array([1, 2, 3]);
    const copy = copyBytes(src);
    copy[0] = 99;
    expect(src[0]).toBe(1); // original untouched (move-not-borrow)
  });
});
