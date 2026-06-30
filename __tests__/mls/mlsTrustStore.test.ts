// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

import nacl from 'tweetnacl';
import {
  pinOrVerifyAik, getTrustRecord, __testHooks,
  setRotationChainFetcher, type RotationChainFetcher,
} from '../../services/mls/mlsGroupStore';
import { toBase64 } from '../../services/cryptoHelpers';
import { signRotationLink, signRotationHead, type AikLink, type AikHead } from '../../services/mls/aikRotation';

const aik = (b: number): Uint8Array => new Uint8Array(32).fill(b);

type KP = { publicKey: Uint8Array; secretKey: Uint8Array };
const kp = (): KP => nacl.sign.keyPair();
const b64 = (k: Uint8Array): string => toBase64(k);
function mkLink(userId: string, seq: number, prev: KP, next: KP): AikLink {
  return signRotationLink({ userId, seq, oldAikPub: prev.publicKey, newAikPub: next.publicKey, oldAikPriv: prev.secretKey });
}
function mkHead(userId: string, seq: number, cur: KP): AikHead {
  return signRotationHead({ userId, seq, aikPub: cur.publicKey, aikPriv: cur.secretKey });
}
const fetcher = (value: { chain: AikLink[]; head: AikHead | null }): RotationChainFetcher => async () => value;

describe('mls trust store', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory(); // fresh DB per test
    __testHooks.resetDbHandle(); // drop the memoized handle so the fresh IDBFactory is honored
  });

  it('TOFU-pins an AIK on first sight and accepts it again', async () => {
    const u = randomUUID();
    expect(await pinOrVerifyAik(u, aik(1))).toBe(true);   // first sight: pin
    expect(await pinOrVerifyAik(u, aik(1))).toBe(true);   // same AIK: accept
    const rec = await getTrustRecord(u);
    expect(rec?.verified).toBe(false);
    expect(rec?.pinnedAik).toBe(Buffer.from(aik(1)).toString('base64'));
  });

  it('rejects a different AIK for an already-pinned user without overwriting', async () => {
    const u = randomUUID();
    expect(await pinOrVerifyAik(u, aik(1))).toBe(true);
    expect(await pinOrVerifyAik(u, aik(2))).toBe(false);  // mismatch: reject
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(Buffer.from(aik(1)).toString('base64')); // unchanged
  });

  it('appends new devices and stores AIK ciphertext, not plaintext, at rest', async () => {
    const u = randomUUID();
    const d1 = randomUUID();
    await pinOrVerifyAik(u, aik(7), { deviceId: d1, leafKey: new Uint8Array(32).fill(9) });
    await pinOrVerifyAik(u, aik(7), { deviceId: randomUUID(), leafKey: new Uint8Array(32).fill(8) });
    const rec = await getTrustRecord(u);
    expect(rec?.devices.length).toBe(2);
    // raw IDB row must not contain the cleartext leaf key bytes
    const { openDB } = await import('idb');
    const db = await openDB('howl_mls', 7);
    const raw = await db.get('trust', u);
    // on-disk row is ciphertext-only: { userId, encrypted, iv } — no cleartext fields
    expect(Object.keys(raw).sort()).toEqual(['encrypted', 'iv', 'userId']);
    // encrypted/iv are non-empty ArrayBuffers. (Use constructor.name, not
    // `instanceof`: fake-indexeddb deserializes the structured-cloned buffer in a
    // different realm, so cross-realm `instanceof ArrayBuffer` is false even though
    // it is a genuine, non-empty ArrayBuffer — which `new Uint8Array(...)` confirms.)
    expect(raw.encrypted?.constructor?.name).toBe('ArrayBuffer');
    expect(raw.encrypted.byteLength).toBeGreaterThan(0);
    expect(raw.iv?.constructor?.name).toBe('ArrayBuffer');
    expect(raw.iv.byteLength).toBeGreaterThan(0);
    // the actual ciphertext bytes must not contain the cleartext leaf-key byte runs
    const ctBytes = Array.from(new Uint8Array(raw.encrypted)).join(',');
    expect(ctBytes).not.toContain('9,9,9'); // no plaintext leaf bytes (device 1)
    expect(ctBytes).not.toContain('8,8,8'); // no plaintext leaf bytes (device 2)
  });
});

describe('mls trust store — rotation-attestation', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __testHooks.resetDbHandle();
    __testHooks.resetRotationStateForTest();
  });

  it('advances an unverified pin across an attested forward rotation (silently)', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    expect(await pinOrVerifyAik(u, p.publicKey)).toBe(true); // TOFU-pin P
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, c)], head: mkHead(u, 1, c) }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(true); // attested advance to C
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(c.publicKey));
    expect(rec?.pinnedSeq).toBe(1);
    expect(rec?.aikHistory).toEqual([b64(p.publicKey), b64(c.publicKey)]);
    expect(rec?.verified).toBe(false);
  });

  it('walks a multi-hop chain in a single advance', async () => {
    const u = randomUUID();
    const p = kp(); const a = kp(); const c = kp();
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, a), mkLink(u, 2, a, c)], head: mkHead(u, 2, c) }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(true);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(c.publicKey));
    expect(rec?.pinnedSeq).toBe(2);
    expect(rec?.aikHistory).toEqual([b64(p.publicKey), b64(a.publicKey), b64(c.publicKey)]);
  });

  it('regression: a mismatch with NO chain still fails closed', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(false);
    expect((await getTrustRecord(u))?.pinnedAik).toBe(b64(p.publicKey)); // unchanged
  });

  it('fails closed on mismatch when offline (no fetcher injected)', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    await pinOrVerifyAik(u, p.publicKey);
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(false);
    expect((await getTrustRecord(u))?.pinnedAik).toBe(b64(p.publicKey));
  });

  it('regression: a forged ancestor (served backward link) never admits a new key', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp(); const attacker = kp();
    await pinOrVerifyAik(u, p.publicKey);
    // Server serves attacker->P (forged) and P->C signed by the attacker, NOT by P.
    const forgedToP: AikLink = {
      seq: 1, oldAik: b64(attacker.publicKey), newAik: b64(p.publicKey),
      signature: signRotationLink({ userId: u, seq: 1, oldAikPub: attacker.publicKey, newAikPub: p.publicKey, oldAikPriv: attacker.secretKey }).signature,
    };
    const forgedFromP: AikLink = {
      seq: 2, oldAik: b64(p.publicKey), newAik: b64(c.publicKey),
      signature: signRotationLink({ userId: u, seq: 2, oldAikPub: p.publicKey, newAikPub: c.publicKey, oldAikPriv: attacker.secretKey }).signature,
    };
    setRotationChainFetcher(fetcher({ chain: [forgedToP, forgedFromP], head: null }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(false);
    expect((await getTrustRecord(u))?.pinnedAik).toBe(b64(p.publicKey));
  });

  it('accepts a lagging older leaf in local history without moving the pin', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, c)], head: mkHead(u, 1, c) }));
    await pinOrVerifyAik(u, c.publicKey); // advance to C (history now [P, C])
    expect(await pinOrVerifyAik(u, p.publicKey, { deviceId: randomUUID(), leafKey: new Uint8Array(32).fill(3) })).toBe(true);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(c.publicKey)); // pin did NOT regress
  });

  it('a verified pin advances for continuity but DROPS verified + stamps rotatedAt', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    const now = Date.now();
    await __testHooks.writeTrustRecordForTest({
      userId: u, pinnedAik: b64(p.publicKey), verified: true,
      firstSeen: now, lastSeen: now, devices: [], aikHistory: [b64(p.publicKey)], pinnedSeq: 0,
    });
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, c)], head: mkHead(u, 1, c) }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(true);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(c.publicKey));
    expect(rec?.verified).toBe(false);
    expect(typeof rec?.rotatedAt).toBe('number');
  });

  it('the account treats its own userId like any peer (no blanket self-trust)', async () => {
    // Our own userId gets the SAME chain-governed treatment: TOFU-pin our real AIK, then
    // reject an AIK we never held (an attacker leaf claiming our userId must NOT be
    // blanket-trusted). A valid own chain still advances it (covered by the advance tests).
    const u = randomUUID();
    const mine = kp(); const attacker = kp();
    expect(await pinOrVerifyAik(u, mine.publicKey)).toBe(true); // TOFU-pin our real AIK
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    expect(await pinOrVerifyAik(u, attacker.publicKey)).toBe(false); // attacker AIK, no chain → reject
    expect((await getTrustRecord(u))?.pinnedAik).toBe(b64(mine.publicKey)); // pin unchanged
  });

  it('concurrent advances converge (per-user CAS, no divergence)', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, c)], head: mkHead(u, 1, c) }));
    const [a, b] = await Promise.all([pinOrVerifyAik(u, c.publicKey), pinOrVerifyAik(u, c.publicKey)]);
    expect(a && b).toBe(true);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(c.publicKey));
    expect(rec?.pinnedSeq).toBe(1);
  });
});
