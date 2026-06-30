// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Stage host attestation verification (verifySignedHost).
 *
 * Stages have no signed leader election. verifySignedHost requires the host's
 * signed attestation, verifies it against the host's client-pinned AIK, and
 * returns the wrap key bound in that attestation (never the server-supplied
 * key). A missing / forged / substituted attestation must fail closed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import {
  verifySignedHost,
  type SignedStageHostBlob,
  type TrustedSigningKeyResolver,
} from '../services/stageE2ee';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const utf8Bytes = (s: string) => {
  const enc = new TextEncoder().encode(s);
  return new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
};

/** In-memory TOFU resolver mirroring mlsGroupStore.pinOrVerifyAik. */
function makeTofuResolver(): TrustedSigningKeyResolver {
  const pins = new Map<string, string>();
  return async (userId, claimed) => {
    const pinned = pins.get(userId);
    if (pinned === undefined) {
      pins.set(userId, claimed);
      return claimed;
    }
    return pinned === claimed ? pinned : null;
  };
}

const CH = '11111111-1111-1111-1111-111111111111';

function signHost(channelId: string, aikKp = nacl.sign.keyPair(), boxKp = nacl.box.keyPair()) {
  const blob: SignedStageHostBlob = {
    v: 1,
    channelId,
    pub: toB64(boxKp.publicKey),
    sigPub: toB64(aikKp.publicKey),
  };
  const signature = toB64(nacl.sign.detached(utf8Bytes(JSON.stringify(blob)), aikKp.secretKey));
  return { blob, signature, boxKp, aikKp };
}

describe('verifySignedHost', () => {
  it('accepts an honest host attestation and returns the host wrap key', async () => {
    const resolve = makeTofuResolver();
    const { blob, signature, boxKp } = signHost(CH);
    expect(await verifySignedHost(CH, 'host', blob, signature, resolve)).toBe(toB64(boxKp.publicKey));
  });

  it('rejects a missing attestation (fails closed)', async () => {
    const resolve = makeTofuResolver();
    expect(await verifySignedHost(CH, 'host', undefined, undefined, resolve)).toBeNull();
    const { blob } = signHost(CH);
    expect(await verifySignedHost(CH, 'host', blob, undefined, resolve)).toBeNull();
  });

  it('rejects a channel mismatch', async () => {
    const resolve = makeTofuResolver();
    const { blob, signature } = signHost(CH);
    const other = '22222222-2222-2222-2222-222222222222';
    expect(await verifySignedHost(other, 'host', blob, signature, resolve)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const resolve = makeTofuResolver();
    const { blob } = signHost(CH);
    expect(await verifySignedHost(CH, 'host', blob, toB64(nacl.randomBytes(64)), resolve)).toBeNull();
  });

  // A server substitutes a previously-pinned host's signing key and re-signs an
  // attestation with it. The pin mismatch rejects it, so the audience never
  // decrypts with the attacker's wrap key.
  it('rejects a server-substituted host signing key after the first pin', async () => {
    const resolve = makeTofuResolver();
    const real = signHost(CH);
    expect(await verifySignedHost(CH, 'host', real.blob, real.signature, resolve)).toBe(
      toB64(real.boxKp.publicKey),
    );

    const attackerAik = nacl.sign.keyPair();
    const attackerBox = nacl.box.keyPair();
    const forged = signHost(CH, attackerAik, attackerBox);
    expect(await verifySignedHost(CH, 'host', forged.blob, forged.signature, resolve)).toBeNull();
  });

  it('binds the wrap key to the attestation: returns the signed host pub, not any server-supplied key', async () => {
    const resolve = makeTofuResolver();
    const { blob, signature, boxKp } = signHost(CH);
    // The audience must decrypt with THIS key; a server cannot swap in a wrap key
    // it controls because the wrap key is covered by the host's signature.
    expect(await verifySignedHost(CH, 'newhost', blob, signature, resolve)).toBe(toB64(boxKp.publicKey));
  });
});
