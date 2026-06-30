// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
//
// AIK rotation-attestation chain.
//
// A user's account identity key (AIK, Ed25519) can legitimately rotate (move to
// Maximum Privacy, recover, etc.). Before this module, a peer that had TOFU-pinned
// the OLD AIK rejected every leaf carrying the NEW one ("Could not validate
// credential") and the conversation stranded. This module lets a peer ADVANCE its
// pin across a legitimate rotation WITHOUT weakening the pin, by following a chain
// of predecessor-signed links rooted at the verifier's OWN locally-pinned anchor.
//
// Threat model: the adversary is the SERVER. It stores the chain opaquely and does
// zero crypto; it may serve/withhold/reorder/truncate/fork/cross-graft the bytes,
// but it holds NO AIK private key. The invariant: a pin advances only to a key C
// for which a chain of predecessor-signed links P -> ... -> C exists, with strictly
// contiguous ascending seq, ROOTED at the verifier's own pinned anchor P (the first
// retained link's oldAik == P and its signature verifies under P). The server cannot
// produce the first hop out of any P it did not generate. Anything unattested,
// unrooted, non-linear, or broken fails closed.
//
// This is a CONTINUITY mechanism, explicitly NOT compromise-recovery: a leaked
// HISTORICAL AIK private key can mint a valid successor, and a withholding/colluding
// server can steer peers pinned at-or-before it. Rotation is not revocation. This is
// consistent with Howl's documented "no post-compromise security" non-goal. The
// chain confers ZERO decryption capability (public AIKs + detached signatures only).
//
// Two domain-separated, fixed-layout raw Ed25519 messages (tweetnacl, mirroring the
// device cross-signature in mlsIdentity.ts — NOT ts-mls signWithLabel):
//   Link: LINK_LABEL || userId(36 ascii) || seq(uint32 BE) || oldAik(32) || newAik(32)
//         signed UNDER the predecessor (oldAik) private key.
//   Head: HEAD_LABEL || userId(36 ascii) || seq(uint32 BE) || aik(32)
//         signed UNDER the new current AIK private key (freshness / anti-rollback).
// Every field after the compile-time label is fixed-length, so the concatenation is
// unambiguous; the labels are distinct and none is a byte-prefix of another, so a
// signature minted for one context can never be replayed as the other (or as the
// device cross-signature). The userId is part of the signed bytes, blocking
// cross-user replay; the label is compiled in, never taken from the server.

import nacl from 'tweetnacl';
import { toBase64, fromBase64 } from '../cryptoHelpers';

/** Domain-separation label for a rotation LINK (signed under the predecessor AIK). */
export const LINK_LABEL = 'howl:mls:aik-rotation:v1';
/** Domain-separation label for a rotation HEAD (signed under the new current AIK). */
export const HEAD_LABEL = 'howl:mls:aik-head:v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AIK_LEN = 32; // Ed25519 public key
const SIG_LEN = 64; // Ed25519 detached signature
const MAX_SEQ = 0xffffffff; // uint32

/** One predecessor-signed hop oldAik -> newAik at a 1-based per-user sequence. */
export interface AikLink {
  seq: number;
  oldAik: string; // base64 Ed25519 public key (predecessor)
  newAik: string; // base64 Ed25519 public key (successor)
  signature: string; // base64 Ed25519 detached signature over the link message, under oldAik
}

/** The signed current head: anti-rollback freshness anchor at the chain tip. */
export interface AikHead {
  seq: number;
  aik: string; // base64 Ed25519 public key (current head == chain tip's newAik)
  signature: string; // base64 Ed25519 detached signature over the head message, under aik
}

/** Locally-persisted trust context the verifier roots its decision in. */
export interface ChainContext {
  /** P — the verifier's currently pinned AIK (base64). */
  pinnedAik: string;
  /** Anti-rollback floor: the seq of the link that produced the current pin (0 for a genesis TOFU pin). */
  pinnedSeq?: number;
  /** Locally-walked AIK history (oldest -> newest, ending at pinnedAik). Backward acceptance uses ONLY this. */
  aikHistory?: string[];
}

export type ChainVerdict =
  /** A verified forward chain rooted at P reaches C: advance the pin to C. */
  | { kind: 'advance'; newPin: string; newSeq: number; history: string[] }
  /** C is an older-but-genuine AIK we already walked through: accept the leaf, do NOT move the pin. */
  | { kind: 'lagging' }
  /** Unattested / unrooted / non-linear / broken / rolled-back: fail closed. */
  | { kind: 'reject' };

function uint32BE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function isValidSeq(seq: number): boolean {
  return Number.isInteger(seq) && seq >= 1 && seq <= MAX_SEQ;
}

/** Decode a base64 value and assert it is exactly `len` bytes; null on any failure. */
function decodeFixed(b64: string, len: number): Uint8Array | null {
  if (typeof b64 !== 'string') return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch {
    return null;
  }
  return bytes.length === len ? bytes : null;
}

function isKeyB64(b64: string): boolean {
  return decodeFixed(b64, AIK_LEN) !== null;
}

function isSigB64(b64: string): boolean {
  return decodeFixed(b64, SIG_LEN) !== null;
}

/** The raw Ed25519 message a rotation LINK signs (under the predecessor AIK). */
export function buildLinkMessage(
  userId: string, seq: number, oldAik: Uint8Array, newAik: Uint8Array,
): Uint8Array {
  if (!UUID_RE.test(userId)) throw new Error('buildLinkMessage: userId is not a UUID');
  if (!isValidSeq(seq)) throw new Error('buildLinkMessage: seq out of range');
  if (oldAik.length !== AIK_LEN || newAik.length !== AIK_LEN) throw new Error('buildLinkMessage: AIK must be 32 bytes');
  const enc = new TextEncoder();
  return concat([enc.encode(LINK_LABEL), enc.encode(userId), uint32BE(seq), oldAik, newAik]);
}

/** The raw Ed25519 message a rotation HEAD signs (under the new current AIK). */
export function buildHeadMessage(userId: string, seq: number, aik: Uint8Array): Uint8Array {
  if (!UUID_RE.test(userId)) throw new Error('buildHeadMessage: userId is not a UUID');
  if (!isValidSeq(seq)) throw new Error('buildHeadMessage: seq out of range');
  if (aik.length !== AIK_LEN) throw new Error('buildHeadMessage: AIK must be 32 bytes');
  const enc = new TextEncoder();
  return concat([enc.encode(HEAD_LABEL), enc.encode(userId), uint32BE(seq), aik]);
}

/** Build + sign a rotation LINK under the predecessor (old) AIK private key. */
export function signRotationLink(params: {
  userId: string; seq: number;
  oldAikPub: Uint8Array; newAikPub: Uint8Array; oldAikPriv: Uint8Array;
}): AikLink {
  const msg = buildLinkMessage(params.userId, params.seq, params.oldAikPub, params.newAikPub);
  const sig = nacl.sign.detached(msg, params.oldAikPriv);
  return {
    seq: params.seq,
    oldAik: toBase64(params.oldAikPub),
    newAik: toBase64(params.newAikPub),
    signature: toBase64(sig),
  };
}

/** Build + sign a rotation HEAD under the new current AIK private key. */
export function signRotationHead(params: {
  userId: string; seq: number; aikPub: Uint8Array; aikPriv: Uint8Array;
}): AikHead {
  const msg = buildHeadMessage(params.userId, params.seq, params.aikPub);
  const sig = nacl.sign.detached(msg, params.aikPriv);
  return { seq: params.seq, aik: toBase64(params.aikPub), signature: toBase64(sig) };
}

/** Verify a base64 detached signature over `msg` under a base64 public key; fail closed. */
function verifyDetached(msg: Uint8Array, sigB64: string, pubB64: string): boolean {
  const sig = decodeFixed(sigB64, SIG_LEN);
  const pub = decodeFixed(pubB64, AIK_LEN);
  if (!sig || !pub) return false;
  try {
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

/**
 * Structural validity only (NO crypto, NO server trust): the chain must be a single
 * simple linear path. Rejects branches, DAGs, dup seq/keys, gaps, and self-loops.
 * An empty chain is vacuously well-formed (it simply offers no forward path). The
 * per-link signatures are verified later, during the P-rooted forward walk.
 */
export function verifyChainWellFormed(chain: AikLink[]): boolean {
  if (!Array.isArray(chain)) return false;
  if (chain.length === 0) return true;
  const sorted = [...chain].sort((a, b) => a.seq - b.seq);
  const olds = new Set<string>();
  const news = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i];
    if (!l || !isValidSeq(l.seq)) return false;
    if (!isKeyB64(l.oldAik) || !isKeyB64(l.newAik) || !isSigB64(l.signature)) return false;
    if (l.oldAik === l.newAik) return false; // no self-loop
    if (i > 0) {
      if (l.seq !== sorted[i - 1].seq + 1) return false; // strictly contiguous ascending
      if (l.oldAik !== sorted[i - 1].newAik) return false; // contiguous linkage
    }
    if (olds.has(l.oldAik) || news.has(l.newAik)) return false; // single out- AND in-degree
    olds.add(l.oldAik);
    news.add(l.newAik);
  }
  return true;
}

/**
 * Decide whether a peer's presented AIK `candidate` may be trusted given the
 * verifier's locally-pinned context, a server-served chain, and an optional head.
 *
 *  (0) Well-formedness — no server trust. The optional head, when present, must bind
 *      the chain TIP (head.seq == tip.seq, head.aik == tip.newAik), verify under its
 *      own key, and not fall below the anti-rollback floor; a present-but-invalid head
 *      is treated as tampering and blocks any forward advance.
 *  (1) FORWARD anchor — find the unique link whose oldAik == P, require its signature
 *      to verify under P (the server cannot forge this without P's private key), then
 *      follow the contiguous forward path verifying each hop under its predecessor. If
 *      `candidate` is reached at a seq above the floor, advance the pin to it.
 *  (2) BACKWARD — only against the verifier's LOCALLY-persisted history (never a
 *      server-served backward link): a candidate we already walked through is a
 *      lagging-but-genuine leaf; accept it without moving the pin.
 *  Otherwise reject (fail closed).
 */
export function verifyChainAndConnect(params: {
  userId: string;
  candidate: string; // C (base64)
  ctx: ChainContext;
  chain: AikLink[];
  head: AikHead | null;
}): ChainVerdict {
  const { userId, candidate, ctx, chain, head } = params;
  if (!UUID_RE.test(userId) || !isKeyB64(candidate)) return { kind: 'reject' };
  const P = ctx.pinnedAik;
  const floor = ctx.pinnedSeq ?? 0;
  const history = ctx.aikHistory ?? [];
  // Backward acceptance is independent of the served chain.
  const backwardOk = history.includes(candidate);
  const fallback: ChainVerdict = backwardOk ? { kind: 'lagging' } : { kind: 'reject' };

  if (!verifyChainWellFormed(chain) || chain.length === 0) return fallback;

  // Optional head: freshness / anti-rollback bound to the chain tip.
  const tip = chain[chain.length - 1];
  let headBlocksAdvance = false;
  if (head) {
    const headAik = decodeFixed(head.aik, AIK_LEN);
    const headSeqValid = isValidSeq(head.seq); // validate BEFORE buildHeadMessage (which throws on a bad seq)
    const headSigOk = headAik !== null && headSeqValid
      && verifyDetached(buildHeadMessage(userId, head.seq, headAik), head.signature, head.aik);
    const bindsTip = head.seq === tip.seq && head.aik === tip.newAik;
    const aboveFloor = headSeqValid && head.seq >= floor;
    if (!(headSigOk && bindsTip && aboveFloor)) headBlocksAdvance = true; // present but bad → no advance
  }

  // FORWARD: anchor at our own pin P; verify each hop under its (already-trusted) predecessor.
  let cur = chain.find((l) => l.oldAik === P) ?? null;
  if (cur) {
    const reached: string[] = [];
    let hopOk = verifyDetached(
      buildLinkMessage(userId, cur.seq, fromBase64(cur.oldAik), fromBase64(cur.newAik)),
      cur.signature, cur.oldAik, // signed under P
    );
    for (let steps = 0; hopOk && steps < chain.length; steps++) {
      reached.push(cur.newAik);
      if (cur.newAik === candidate) {
        if (cur.seq > floor && !headBlocksAdvance) {
          const base = history.length > 0 ? history.slice() : [P];
          for (const k of reached) if (!base.includes(k)) base.push(k);
          return { kind: 'advance', newPin: candidate, newSeq: cur.seq, history: base };
        }
        break; // reached but cannot advance (rollback or head tampering) → fall to backward
      }
      const next = chain.find((l) => l.oldAik === cur!.newAik) ?? null;
      if (!next) break;
      hopOk = verifyDetached(
        buildLinkMessage(userId, next.seq, fromBase64(next.oldAik), fromBase64(next.newAik)),
        next.signature, next.oldAik, // signed under cur.newAik, which we just verified
      );
      cur = next;
    }
  }

  return fallback;
}
