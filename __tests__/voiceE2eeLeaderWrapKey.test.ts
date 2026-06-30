// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Voice key-receipt binding (resolveLeaderWrapKey).
 *
 * Election picks WHO the leader is; receipt must decrypt with the leader's
 * signature-verified wrap key (blob.pub), never the server wire key. Covers:
 * returns the verified leader's blob.pub (not a substituted wire key); fails
 * closed when its blob isn't cached; falls back to the server key only before a
 * leader is verified; and the consequence — a server that keeps the real
 * leaderUserId but swaps in its own wrap key can't get its sealed key to open.
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { resolveLeaderWrapKey, type SignedVoiceParticipant } from '../services/voiceE2ee';

const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** A signed participant whose blob.pub is the given box keypair's public key. */
function participant(
  userId: string,
  channelId: string,
  joinTimestamp: number,
  boxKp: ReturnType<typeof nacl.box.keyPair>,
): SignedVoiceParticipant {
  const sigKp = nacl.sign.keyPair();
  const blob = {
    v: 1 as const,
    channelId,
    joinTimestamp,
    pub: toB64(boxKp.publicKey),
    sigPub: toB64(sigKp.publicKey),
  };
  const bytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(blob)));
  const signature = toB64(nacl.sign.detached(bytes, sigKp.secretKey));
  return { userId, blob, signature, signingPublicKey: toB64(sigKp.publicKey) };
}

describe('resolveLeaderWrapKey (voice key-receipt binding)', () => {
  const CH = 'ch-1';

  it("returns the verified leader's blob.pub, NOT the server-supplied wire key", () => {
    const leader = participant('leader', CH, 100, nacl.box.keyPair());
    const attackerWireKey = toB64(nacl.box.keyPair().publicKey);
    expect(resolveLeaderWrapKey('leader', [leader], attackerWireKey)).toBe(leader.blob.pub);
    expect(resolveLeaderWrapKey('leader', [leader], attackerWireKey)).not.toBe(attackerWireKey);
  });

  it('fails closed (null) when the verified leader has no cached signed blob', () => {
    const other = participant('other', CH, 200, nacl.box.keyPair());
    const wireKey = toB64(nacl.box.keyPair().publicKey);
    expect(resolveLeaderWrapKey('leader', [other], wireKey)).toBeNull();
    expect(resolveLeaderWrapKey('leader', [], wireKey)).toBeNull();
  });

  it('falls back to the server-attested key only before any leader is verified (bootstrap/legacy)', () => {
    const serverKey = toB64(nacl.box.keyPair().publicKey);
    expect(resolveLeaderWrapKey(null, [], serverKey)).toBe(serverKey);
  });

  // Consequence: decrypting with the resolved (verified leader's) key means a
  // server that keeps the real leaderUserId but seals a key under its own wrap
  // key can't get it to open, while the honest leader's key does.
  it('attacker-substituted session key fails to open under the resolved (verified) key; the honest one opens', () => {
    const receiver = nacl.box.keyPair(); // us
    const leaderBox = nacl.box.keyPair(); // the genuine elected leader
    const leader = participant('leader', CH, 100, leaderBox);

    const sessionKey = nacl.randomBytes(32);

    // Honest leader seals the real session key to us under its real key.
    const honestNonce = nacl.randomBytes(nacl.box.nonceLength);
    const honestCt = nacl.box(sessionKey, honestNonce, receiver.publicKey, leaderBox.secretKey);

    // Malicious server: real leaderUserId on the wire, but an attacker wrap key
    // and a DIFFERENT (attacker) session key sealed to us under the attacker key.
    const attackerBox = nacl.box.keyPair();
    const attackerSessionKey = nacl.randomBytes(32);
    const attackNonce = nacl.randomBytes(nacl.box.nonceLength);
    const attackCt = nacl.box(attackerSessionKey, attackNonce, receiver.publicKey, attackerBox.secretKey);

    // The receiver resolves the wrap key from the verified roster, ignoring the
    // attacker wire key the server claims.
    const wrapKey = resolveLeaderWrapKey('leader', [leader], toB64(attackerBox.publicKey));
    expect(wrapKey).toBe(leader.blob.pub);
    const senderPub = fromB64(wrapKey!);

    // Honest ciphertext opens under the resolved key and yields the real key.
    const opened = nacl.box.open(honestCt, honestNonce, senderPub, receiver.secretKey);
    expect(opened).not.toBeNull();
    expect(toB64(opened!)).toBe(toB64(sessionKey));

    // Attacker ciphertext does NOT open under the resolved (leader's real) key.
    const attackerOpened = nacl.box.open(attackCt, attackNonce, senderPub, receiver.secretKey);
    expect(attackerOpened).toBeNull();
  });
});
