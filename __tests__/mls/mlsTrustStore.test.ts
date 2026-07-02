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
  setOwnAikHint, setPinRejectionListener, setPinResolutionListener,
  acceptPinOverride, listPinRejections,
  type PinRejection,
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

describe('mls trust store — key-change acknowledgement', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    __testHooks.resetDbHandle();
    __testHooks.resetRotationStateForTest();
  });

  it('records a DEFINITIVE rejection (chain fetched, verdict reject) and notifies once', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    const seen: PinRejection[] = [];
    setPinRejectionListener((e) => seen.push(e));
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [], head: null })); // chain-less reset AIK
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(false);
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(false); // re-validation: no re-notify
    expect(seen).toEqual([{ userId: u, candidateAik: b64(c.publicKey), pinnedAik: b64(p.publicKey), self: false }]);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(p.publicKey)); // still fail-closed
    expect(rec?.rejectedAiks).toEqual([b64(c.publicKey)]); // persisted for UI hydration
    expect(await listPinRejections()).toEqual(seen);
  });

  it('does NOT record a transient (offline, no fetcher) rejection', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp();
    const seen: PinRejection[] = [];
    setPinRejectionListener((e) => seen.push(e));
    await pinOrVerifyAik(u, p.publicKey);
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(false); // no fetcher: transient fail-closed
    expect(seen).toEqual([]);
    expect((await getTrustRecord(u))?.rejectedAiks).toBeUndefined();
  });

  it('self-heals a stale self-pin to the OWN currently-held AIK (possession proof)', async () => {
    const u = randomUUID();
    const old = kp(); const mine = kp();
    await pinOrVerifyAik(u, old.publicKey); // stale pre-reset self-pin
    setOwnAikHint({ userId: u, aikB64: b64(mine.publicKey) });
    expect(await pinOrVerifyAik(u, mine.publicKey)).toBe(true); // heals, no chain needed
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(mine.publicKey));
    // History TRUNCATES on a manual move: the superseded (possibly compromised) key
    // must not stay backward-acceptable via the lagging path.
    expect(rec?.aikHistory).toEqual([b64(mine.publicKey)]);
    expect(rec?.rejectedAiks).toBeUndefined();
  });

  it('never self-heals BACKWARD to a superseded own key already in history (floor-reset attack)', async () => {
    const u = randomUUID();
    const a = kp(); const b = kp();
    await pinOrVerifyAik(u, a.publicKey); // TOFU A
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, a, b)], head: mkHead(u, 1, b) }));
    expect(await pinOrVerifyAik(u, b.publicKey)).toBe(true); // attested advance: pin=B, seq=1, history=[A,B]
    // Server rolls our vault back so this device's held AIK becomes A again.
    setOwnAikHint({ userId: u, aikB64: b64(a.publicKey) });
    // A is in history: accepted as LAGGING, but the pin and anti-rollback floor stay put.
    expect(await pinOrVerifyAik(u, a.publicKey)).toBe(true);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(b.publicKey)); // NOT moved backward
    expect(rec?.pinnedSeq).toBe(1); // floor intact
  });

  it('the self hint never admits a key we do not hold (anti-injection preserved)', async () => {
    const u = randomUUID();
    const mine = kp(); const attacker = kp();
    await pinOrVerifyAik(u, mine.publicKey);
    setOwnAikHint({ userId: u, aikB64: b64(mine.publicKey) });
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    expect(await pinOrVerifyAik(u, attacker.publicKey)).toBe(false);
    expect((await getTrustRecord(u))?.pinnedAik).toBe(b64(mine.publicKey));
    expect((await listPinRejections())[0]?.self).toBe(true); // flagged as a SELF alert
  });

  it('acceptPinOverride moves the pin ONLY to an observed-and-rejected candidate', async () => {
    const u = randomUUID();
    const p = kp(); const c = kp(); const never = kp();
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    await pinOrVerifyAik(u, c.publicKey); // records the rejection
    expect(await acceptPinOverride(u, b64(never.publicKey))).toBe(false); // never observed
    expect(await acceptPinOverride(u, b64(c.publicKey))).toBe(true);
    const rec = await getTrustRecord(u);
    expect(rec?.pinnedAik).toBe(b64(c.publicKey));
    expect(rec?.aikHistory).toEqual([b64(c.publicKey)]); // TRUNCATED: continuity is severed by definition
    expect(rec?.pinnedSeq).toBe(0); // genesis-like anti-rollback floor
    expect(rec?.verified).toBe(false);
    expect(rec?.rejectedAiks).toBeUndefined(); // cleared
    expect(await listPinRejections()).toEqual([]);
    // The accepted key now validates like any pinned key.
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(true);
    // The superseded key is NOT backward-acceptable: it re-surfaces as a fresh rejection.
    expect(await pinOrVerifyAik(u, p.publicKey)).toBe(false);
    expect((await getTrustRecord(u))?.rejectedAiks).toEqual([b64(p.publicKey)]);
  });

  it('notifies resolution when an attested advance or an accept clears pending rejections', async () => {
    const u = randomUUID();
    const p = kp(); const evil = kp(); const c = kp();
    const resolved: string[] = [];
    setPinResolutionListener((userId) => resolved.push(userId));
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    await pinOrVerifyAik(u, evil.publicKey); // rejection recorded
    __testHooks.resetRotationStateForTest(); // bust the chain cache
    setPinResolutionListener((userId) => resolved.push(userId));
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, c)], head: mkHead(u, 1, c) }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(true); // attested advance clears the rejection
    expect(resolved).toEqual([u]);
    // ...and an accept notifies too.
    const u2 = randomUUID();
    const p2 = kp(); const c2 = kp();
    await pinOrVerifyAik(u2, p2.publicKey);
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    await pinOrVerifyAik(u2, c2.publicKey);
    await acceptPinOverride(u2, b64(c2.publicKey));
    expect(resolved).toEqual([u, u2]);
  });

  it('acceptPinOverride is idempotent when the candidate is already the pin', async () => {
    const u = randomUUID();
    const p = kp();
    await pinOrVerifyAik(u, p.publicKey);
    expect(await acceptPinOverride(u, b64(p.publicKey))).toBe(true);
    expect((await getTrustRecord(u))?.pinnedAik).toBe(b64(p.publicKey));
  });

  it('an attested advance clears stale pending rejections', async () => {
    const u = randomUUID();
    const p = kp(); const evil = kp(); const c = kp();
    await pinOrVerifyAik(u, p.publicKey);
    setRotationChainFetcher(fetcher({ chain: [], head: null }));
    await pinOrVerifyAik(u, evil.publicKey); // rejection recorded
    __testHooks.resetRotationStateForTest(); // bust the 60s chain cache (still holds the empty chain)
    setRotationChainFetcher(fetcher({ chain: [mkLink(u, 1, p, c)], head: mkHead(u, 1, c) }));
    expect(await pinOrVerifyAik(u, c.publicKey)).toBe(true); // legitimate rotation lands
    expect((await getTrustRecord(u))?.rejectedAiks).toBeUndefined();
    expect(await listPinRejections()).toEqual([]);
  });
});
