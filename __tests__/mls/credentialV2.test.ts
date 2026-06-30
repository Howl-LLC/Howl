// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { getImpl } from '../../services/mls/ciphersuite';
import {
  encodeMlsCredentialIdentity, decodeMlsCredentialIdentity, buildDeviceXsigMessage,
  buildCrossSignedCredentialIdentity,
} from '../../services/mls/mlsIdentity';
import {
  encodeMlsIdentity, decodeMlsIdentity, MLS_CREDENTIAL_VERSION,
} from '../../backend/src/mls/credential';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('credential v2', () => {
  const aikPub = new Uint8Array(32).fill(3);
  const crossSig = new Uint8Array(64).fill(7);

  it('client and backend encoders produce byte-identical v2 bytes', () => {
    const u = randomUUID(), d = randomUUID();
    const a = encodeMlsCredentialIdentity(u, d, aikPub, crossSig);
    const b = encodeMlsIdentity(u, d, aikPub, crossSig);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(169);
    expect(a[0]).toBe(MLS_CREDENTIAL_VERSION);
  });

  it('round-trips through decode (both sides)', () => {
    const u = randomUUID(), d = randomUUID();
    const bytes = encodeMlsCredentialIdentity(u, d, aikPub, crossSig);
    for (const dec of [decodeMlsCredentialIdentity(bytes), decodeMlsIdentity(bytes)]) {
      expect(dec.userId).toBe(u);
      expect(dec.deviceId).toBe(d);
      expect(Array.from(dec.aikPub)).toEqual(Array.from(aikPub));
      expect(Array.from(dec.crossSig)).toEqual(Array.from(crossSig));
    }
  });

  it('decode fails closed on wrong length and wrong version', () => {
    expect(() => decodeMlsIdentity(new Uint8Array(10))).toThrow();
    const bytes = encodeMlsCredentialIdentity(randomUUID(), randomUUID(), aikPub, crossSig);
    bytes[0] = 0x01;
    expect(() => decodeMlsIdentity(bytes)).toThrow();
  });

  it('a nacl-signed cross-sig verifies under ts-mls impl.signature (interop KAT)', async () => {
    const impl = await getImpl();
    const u = randomUUID(), d = randomUUID();
    const leaf = nacl.sign.keyPair();            // stand-in leaf signing pub
    const aik = nacl.sign.keyPair();             // AIK (Ed25519)
    const id = buildCrossSignedCredentialIdentity(u, d, leaf.publicKey, aik.publicKey, aik.secretKey);
    const dec = decodeMlsCredentialIdentity(id);
    const msg = buildDeviceXsigMessage(u, d, leaf.publicKey);
    expect(await impl.signature.verify(dec.aikPub, msg, dec.crossSig)).toBe(true);
    msg[0] ^= 0xff; // tamper
    expect(await impl.signature.verify(dec.aikPub, msg, dec.crossSig)).toBe(false);
  });
});
