// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Server-side voice-leader election must match the client's
 * `selectSignedLeader` so the server's key-distribution authority and the
 * client's key-accept gate can never disagree.
 *
 * The wedge this closes: the server used to authorize the key-holder strictly
 * by `participants[0]` ordered on server-side `joinedAt`, while clients elect
 * the leader by the *signed* `joinTimestamp` carried in each join-blob. Under
 * ordinary client clock drift those two orderings can flip relative order, so
 * the server-allowed leader's key is rejected by every client and the
 * client-elected leader's distribution is dropped by the server — no SFrame
 * key is ever accepted and the call wedges with no recovery.
 *
 * `electVoiceLeader` re-derives the leader on the server using the SAME rule
 * the client uses (earliest VERIFIED signed joinTimestamp, ties broken by
 * lex-smaller X25519 pub; fall back to the server-attested oldest only when no
 * participant carries a verifying blob), so the two sides converge by
 * construction. Pure in-memory test — no Postgres/Redis/DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import { electVoiceLeader } from '../src/services/voiceLeaderElection.js';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const utf8 = (s: string) => new TextEncoder().encode(s);

const CHAN = 'ch-1';

/** Build a voice participant record exactly as `addVoiceParticipant` stores it
 *  after the server-side join-blob gate accepts the blob. */
function makeParticipant(
  userId: string,
  joinTimestamp: number,
  joinedAt: number,
  opts: { channelId?: string; sigKp?: nacl.SignKeyPair; boxKp?: nacl.BoxKeyPair } = {},
) {
  const channelId = opts.channelId ?? CHAN;
  const sigKp = opts.sigKp ?? nacl.sign.keyPair();
  const boxKp = opts.boxKp ?? nacl.box.keyPair();
  const blob = { v: 1 as const, channelId, joinTimestamp, pub: b64(boxKp.publicKey), sigPub: b64(sigKp.publicKey) };
  const signature = b64(nacl.sign.detached(utf8(JSON.stringify(blob)), sigKp.secretKey));
  return { userId, joinBlob: blob, signature, signingPublicKey: b64(sigKp.publicKey), joinedAt };
}

/** A participant that never published a signed join-blob (legacy/locked vault). */
function makeBlobless(userId: string, joinedAt: number) {
  return { userId, joinedAt };
}

describe('electVoiceLeader (server mirrors client selectSignedLeader)', () => {
  it('REGRESSION: picks the earliest signed joinTimestamp even when its joinedAt is LATER (the wedge)', () => {
    // A connected the socket first (joinedAt 100) but its signed clock reads
    // later (joinTimestamp 5000). B connected later (joinedAt 200) but its
    // signed clock reads earlier (joinTimestamp 4000). The client elects B.
    // The OLD server (participants[0] by joinedAt) would have picked A -> wedge.
    const a = makeParticipant('A', 5000, 100);
    const b = makeParticipant('B', 4000, 200);
    // getVoiceParticipants hands them back joinedAt-sorted: [A, B].
    expect(electVoiceLeader(CHAN, [a, b])).toBe('B');
  });

  it('breaks ties on equal joinTimestamp by lex-smaller X25519 pub (matches client)', () => {
    const boxA = nacl.box.keyPair();
    const boxB = nacl.box.keyPair();
    const a = makeParticipant('A', 1000, 100, { boxKp: boxA });
    const b = makeParticipant('B', 1000, 200, { boxKp: boxB });
    const winner = a.joinBlob.pub < b.joinBlob.pub ? 'A' : 'B';
    expect(electVoiceLeader(CHAN, [a, b])).toBe(winner);
    expect(electVoiceLeader(CHAN, [b, a])).toBe(winner);
  });

  it('falls back to the server-attested oldest (joinedAt) when NO participant has a verifying blob', () => {
    // Input is joinedAt-sorted by getVoiceParticipants, so [first] is oldest.
    const older = makeBlobless('older', 100);
    const newer = makeBlobless('newer', 200);
    expect(electVoiceLeader(CHAN, [older, newer])).toBe('older');
  });

  it('a participant WITH a verifying blob beats blob-less participants regardless of joinedAt', () => {
    const blobless = makeBlobless('legacy', 50); // oldest by joinedAt
    const signed = makeParticipant('signed', 9999, 300); // newest by joinedAt
    expect(electVoiceLeader(CHAN, [blobless, signed])).toBe('signed');
  });

  it('ignores a participant whose stored signature does not verify (treats as blob-less)', () => {
    const good = makeParticipant('good', 1000, 200);
    const tampered = { ...makeParticipant('bad', 0, 100), signature: b64(nacl.randomBytes(64)) };
    // bad has the earliest joinTimestamp(0) but a bogus signature -> dropped.
    expect(electVoiceLeader(CHAN, [tampered, good])).toBe('good');
  });

  it('rejects an insider who signs a forged low-timestamp blob with a throwaway key (sigPub != DB key)', () => {
    const honest = makeParticipant('alice', 100, 200);
    // Mallory: real DB signing key, but signs a forged t=0 blob with a throwaway
    // keypair and lies in blob.sigPub. signingPublicKey is the DB-authoritative
    // key, so blob.sigPub !== signingPublicKey -> verification fails.
    const malloryRealSig = nacl.sign.keyPair();
    const throwaway = nacl.sign.keyPair();
    const malloryBox = nacl.box.keyPair();
    const forged = { v: 1 as const, channelId: CHAN, joinTimestamp: 0, pub: b64(malloryBox.publicKey), sigPub: b64(throwaway.publicKey) };
    const mallory = {
      userId: 'mallory',
      joinBlob: forged,
      signature: b64(nacl.sign.detached(utf8(JSON.stringify(forged)), throwaway.secretKey)),
      signingPublicKey: b64(malloryRealSig.publicKey),
      joinedAt: 100,
    };
    expect(electVoiceLeader(CHAN, [mallory, honest])).toBe('alice');
  });

  it('ignores a blob whose channelId mismatches the call', () => {
    const wrongChan = makeParticipant('wrong', 1, 100, { channelId: 'other-channel' });
    const right = makeParticipant('right', 1000, 200);
    expect(electVoiceLeader(CHAN, [wrongChan, right])).toBe('right');
  });

  it('returns null for an empty participant set', () => {
    expect(electVoiceLeader(CHAN, [])).toBeNull();
  });

  it('a single verified participant is the leader regardless of timestamp', () => {
    const solo = makeParticipant('solo', 99999, 500);
    expect(electVoiceLeader(CHAN, [solo])).toBe('solo');
  });
});
