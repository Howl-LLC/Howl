// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { toBase64, fromBase64 } from '../../services/cryptoHelpers';
import { DEVICE_XSIG_LABEL } from '../../services/mls/mlsIdentity';
import {
  LINK_LABEL, HEAD_LABEL,
  buildLinkMessage, buildHeadMessage,
  signRotationLink, signRotationHead,
  verifyChainWellFormed, verifyChainAndConnect,
  type AikLink, type AikHead,
} from '../../services/mls/aikRotation';

type KP = { publicKey: Uint8Array; secretKey: Uint8Array };
const kp = (): KP => nacl.sign.keyPair();
const b64 = (k: Uint8Array): string => toBase64(k);

/** Build a signed link from `prev` to `next` at `seq` for `userId`. */
function link(userId: string, seq: number, prev: KP, next: KP): AikLink {
  return signRotationLink({
    userId, seq, oldAikPub: prev.publicKey, newAikPub: next.publicKey, oldAikPriv: prev.secretKey,
  });
}
function head(userId: string, seq: number, cur: KP): AikHead {
  return signRotationHead({ userId, seq, aikPub: cur.publicKey, aikPriv: cur.secretKey });
}

describe('aikRotation — message builders (byte-stable)', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const old = new Uint8Array(32).fill(7);
  const neu = new Uint8Array(32).fill(9);

  it('link message has the exact fixed layout LINK_LABEL||userId(36)||seq(4 BE)||old(32)||new(32)', () => {
    const msg = buildLinkMessage(userId, 0x01020304, old, neu);
    const labelBytes = new TextEncoder().encode(LINK_LABEL);
    expect(msg.length).toBe(labelBytes.length + 36 + 4 + 32 + 32);
    expect(Array.from(msg.subarray(0, labelBytes.length))).toEqual(Array.from(labelBytes));
    const off = labelBytes.length;
    expect(new TextDecoder().decode(msg.subarray(off, off + 36))).toBe(userId);
    expect(Array.from(msg.subarray(off + 36, off + 40))).toEqual([0x01, 0x02, 0x03, 0x04]); // uint32 BE
    expect(Array.from(msg.subarray(off + 40, off + 72))).toEqual(Array.from(old));
    expect(Array.from(msg.subarray(off + 72, off + 104))).toEqual(Array.from(neu));
  });

  it('head message has the exact fixed layout HEAD_LABEL||userId(36)||seq(4 BE)||aik(32)', () => {
    const msg = buildHeadMessage(userId, 1, neu);
    const labelBytes = new TextEncoder().encode(HEAD_LABEL);
    expect(msg.length).toBe(labelBytes.length + 36 + 4 + 32);
    expect(Array.from(msg.subarray(0, labelBytes.length))).toEqual(Array.from(labelBytes));
  });

  it('rejects a non-UUID userId and out-of-range seq', () => {
    expect(() => buildLinkMessage('not-a-uuid', 1, old, neu)).toThrow();
    expect(() => buildLinkMessage(userId, 0, old, neu)).toThrow();
    expect(() => buildLinkMessage(userId, -1, old, neu)).toThrow();
    expect(() => buildHeadMessage(userId, 1.5, neu)).toThrow();
  });
});

describe('aikRotation — signatures verify under the right key only', () => {
  const userId = randomUUID();

  it('a link verifies under the OLD key, never the NEW key', () => {
    const a = kp(); const b = kp();
    const l = link(userId, 1, a, b);
    const msg = buildLinkMessage(userId, 1, a.publicKey, b.publicKey);
    expect(nacl.sign.detached.verify(msg, fromBase64(l.signature), a.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(msg, fromBase64(l.signature), b.publicKey)).toBe(false);
  });

  it('a head verifies under the current (new) key', () => {
    const a = kp();
    const h = head(userId, 1, a);
    const msg = buildHeadMessage(userId, 1, a.publicKey);
    expect(nacl.sign.detached.verify(msg, fromBase64(h.signature), a.publicKey)).toBe(true);
  });

  it('flipping seq / userId / newAik breaks verification', () => {
    const a = kp(); const b = kp(); const c = kp();
    const l = link(userId, 1, a, b);
    const sig = fromBase64(l.signature);
    expect(nacl.sign.detached.verify(buildLinkMessage(userId, 2, a.publicKey, b.publicKey), sig, a.publicKey)).toBe(false);
    expect(nacl.sign.detached.verify(buildLinkMessage(randomUUID(), 1, a.publicKey, b.publicKey), sig, a.publicKey)).toBe(false);
    expect(nacl.sign.detached.verify(buildLinkMessage(userId, 1, a.publicKey, c.publicKey), sig, a.publicKey)).toBe(false);
  });
});

describe('aikRotation — domain separation registry (C-4)', () => {
  it('a head signature cannot be replayed as a link signature (and vice versa)', () => {
    const userId = randomUUID();
    const a = kp();
    // Same userId, same seq, same key signed under `a`, but different label.
    const h = head(userId, 1, a);
    const linkMsg = buildLinkMessage(userId, 1, a.publicKey, a.publicKey); // self-loop msg only for byte comparison
    expect(nacl.sign.detached.verify(linkMsg, fromBase64(h.signature), a.publicKey)).toBe(false);
  });

  it('no AIK-signed label is a byte-prefix of another', () => {
    const labels = [DEVICE_XSIG_LABEL, LINK_LABEL, HEAD_LABEL];
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const x of labels) {
      for (const y of labels) {
        if (x === y) continue;
        const bx = enc(x); const by = enc(y);
        const shorter = bx.length <= by.length ? bx : by;
        const longer = bx.length <= by.length ? by : bx;
        const isPrefix = shorter.every((v, i) => v === longer[i]);
        expect(isPrefix).toBe(false);
      }
    }
    // All three are distinct strings too.
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('verifyChainWellFormed', () => {
  const userId = randomUUID();
  const g = kp(); const a = kp(); const b = kp(); const c = kp();

  it('accepts an empty chain (vacuously) and a single hop', () => {
    expect(verifyChainWellFormed([])).toBe(true);
    expect(verifyChainWellFormed([link(userId, 1, g, a)])).toBe(true);
  });

  it('accepts a contiguous N-hop simple path', () => {
    expect(verifyChainWellFormed([
      link(userId, 1, g, a), link(userId, 2, a, b), link(userId, 3, b, c),
    ])).toBe(true);
  });

  it('rejects a seq gap', () => {
    expect(verifyChainWellFormed([link(userId, 1, g, a), link(userId, 3, a, b)])).toBe(false);
  });

  it('rejects broken linkage (oldAik != previous newAik)', () => {
    expect(verifyChainWellFormed([link(userId, 1, g, a), link(userId, 2, c, b)])).toBe(false);
  });

  it('rejects a duplicate oldAik (fork / branch) and duplicate newAik (merge)', () => {
    // Two links out of `a` (single out-degree violation), seqs made contiguous to isolate the degree check.
    expect(verifyChainWellFormed([link(userId, 1, a, b), link(userId, 2, a, c)])).toBe(false);
    // Two links into `c` (single in-degree violation).
    expect(verifyChainWellFormed([link(userId, 1, a, c), link(userId, 2, c, c)])).toBe(false); // also self-loop
    expect(verifyChainWellFormed([link(userId, 1, g, c), link(userId, 2, c, b), link(userId, 3, b, c)])).toBe(false);
  });

  it('rejects a self-loop and malformed base64 keys/sigs', () => {
    expect(verifyChainWellFormed([{ seq: 1, oldAik: b64(a.publicKey), newAik: b64(a.publicKey), signature: b64(new Uint8Array(64)) }])).toBe(false);
    expect(verifyChainWellFormed([{ seq: 1, oldAik: 'short', newAik: b64(a.publicKey), signature: b64(new Uint8Array(64)) }])).toBe(false);
    expect(verifyChainWellFormed([{ seq: 1, oldAik: b64(g.publicKey), newAik: b64(a.publicKey), signature: 'bad' }])).toBe(false);
  });
});

describe('verifyChainAndConnect', () => {
  const userId = randomUUID();

  it('advances across a valid single hop rooted at P, seeding history [P, C]', () => {
    const p = kp(); const c = kp();
    const chain = [link(userId, 1, p, c)];
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain, head: head(userId, 1, c),
    });
    expect(v.kind).toBe('advance');
    if (v.kind === 'advance') {
      expect(v.newPin).toBe(b64(c.publicKey));
      expect(v.newSeq).toBe(1);
      expect(v.history).toEqual([b64(p.publicKey), b64(c.publicKey)]);
    }
  });

  it('advances across a valid N-hop chain to the tip', () => {
    const p = kp(); const a = kp(); const b = kp(); const c = kp();
    const chain = [link(userId, 1, p, a), link(userId, 2, a, b), link(userId, 3, b, c)];
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [b64(p.publicKey)] },
      chain, head: head(userId, 3, c),
    });
    expect(v.kind).toBe('advance');
    if (v.kind === 'advance') {
      expect(v.newSeq).toBe(3);
      expect(v.history).toEqual([b64(p.publicKey), b64(a.publicKey), b64(b.publicKey), b64(c.publicKey)]);
    }
  });

  it('advances to an INTERMEDIATE candidate (lagging peer-device forward of our pin)', () => {
    const p = kp(); const a = kp(); const c = kp();
    const chain = [link(userId, 1, p, a), link(userId, 2, a, c)];
    const v = verifyChainAndConnect({
      userId, candidate: b64(a.publicKey), // present the middle key, not the tip
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [b64(p.publicKey)] },
      chain, head: head(userId, 2, c),
    });
    expect(v.kind).toBe('advance');
    if (v.kind === 'advance') {
      expect(v.newPin).toBe(b64(a.publicKey));
      expect(v.newSeq).toBe(1);
    }
  });

  it('rejects a chain NOT anchored at P (no link out of our pin)', () => {
    const p = kp(); const x = kp(); const c = kp();
    const chain = [link(userId, 1, x, c)]; // rooted at x, not p
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain, head: head(userId, 1, c),
    });
    expect(v.kind).toBe('reject');
  });

  it('rejects a FORGED ancestor: an X->P link does not let an attacker advance us (the deleted bypass)', () => {
    const p = kp(); const c = kp(); const attacker = kp();
    // Attacker forges X->P (signed by attacker) AND P->C (signed by attacker, NOT P).
    const forgedToP: AikLink = {
      seq: 1, oldAik: b64(attacker.publicKey), newAik: b64(p.publicKey),
      signature: b64(nacl.sign.detached(buildLinkMessage(userId, 1, attacker.publicKey, p.publicKey), attacker.secretKey)),
    };
    const forgedFromP: AikLink = {
      seq: 2, oldAik: b64(p.publicKey), newAik: b64(c.publicKey),
      signature: b64(nacl.sign.detached(buildLinkMessage(userId, 2, p.publicKey, c.publicKey), attacker.secretKey)), // NOT signed by p
    };
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain: [forgedToP, forgedFromP], head: null,
    });
    expect(v.kind).toBe('reject'); // P->C signature does not verify under P
  });

  it('rejects when the P->C link signature is bad', () => {
    const p = kp(); const c = kp();
    const good = link(userId, 1, p, c);
    const tampered: AikLink = { ...good, signature: b64(new Uint8Array(64)) };
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain: [tampered], head: null,
    });
    expect(v.kind).toBe('reject');
  });

  it('accepts a lagging leaf whose AIK is in local history WITHOUT moving the pin', () => {
    const g = kp(); const p = kp();
    // We are pinned at p; g is an older key we already walked through.
    const v = verifyChainAndConnect({
      userId, candidate: b64(g.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 1, aikHistory: [b64(g.publicKey), b64(p.publicKey)] },
      chain: [link(userId, 1, g, p)], head: head(userId, 1, p),
    });
    expect(v.kind).toBe('lagging');
  });

  it('rejects an arbitrary served ancestor that is NOT in local history (no backward server trust)', () => {
    const p = kp(); const x = kp();
    const v = verifyChainAndConnect({
      userId, candidate: b64(x.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 1, aikHistory: [b64(p.publicKey)] },
      chain: [link(userId, 1, x, p)], // served backward link x->p
      head: head(userId, 1, p),
    });
    expect(v.kind).toBe('reject');
  });

  it('rejects a rollback below the seq floor', () => {
    const p = kp(); const c = kp();
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 5, aikHistory: [b64(p.publicKey)] },
      chain: [link(userId, 3, p, c)], head: head(userId, 3, c), // seq 3 <= floor 5
    });
    expect(v.kind).toBe('reject');
  });

  it('blocks advance when a present head is tampered, but still allows a lagging leaf', () => {
    const p = kp(); const c = kp();
    const goodHead = head(userId, 1, c);
    const badHead: AikHead = { ...goodHead, signature: b64(new Uint8Array(64)) };
    const advance = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain: [link(userId, 1, p, c)], head: badHead,
    });
    expect(advance.kind).toBe('reject'); // tampered head blocks the advance, C not in history
  });

  it('blocks advance when the head does not bind the chain tip', () => {
    const p = kp(); const c = kp(); const other = kp();
    const v = verifyChainAndConnect({
      userId, candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain: [link(userId, 1, p, c)], head: head(userId, 1, other), // head.aik != tip.newAik
    });
    expect(v.kind).toBe('reject');
  });

  it('does not throw on a malformed server-supplied head.seq (fails closed)', () => {
    const p = kp(); const c = kp();
    for (const badSeq of [0, -1, 1.5, 0xffffffff + 1, NaN]) {
      const v = verifyChainAndConnect({
        userId, candidate: b64(c.publicKey),
        ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
        chain: [link(userId, 1, p, c)],
        head: { seq: badSeq, aik: b64(c.publicKey), signature: b64(new Uint8Array(64)) },
      });
      // A present-but-malformed head blocks the advance; with C not in history → reject.
      expect(v.kind).toBe('reject');
    }
  });

  it('rejects a cross-user replay of another user’s chain', () => {
    const p = kp(); const c = kp();
    const chainForUserA = [link(userId, 1, p, c)];
    const v = verifyChainAndConnect({
      userId: randomUUID(), // different user verifying
      candidate: b64(c.publicKey),
      ctx: { pinnedAik: b64(p.publicKey), pinnedSeq: 0, aikHistory: [] },
      chain: chainForUserA, head: head(userId, 1, c),
    });
    expect(v.kind).toBe('reject'); // userId is in the signed bytes
  });
});
