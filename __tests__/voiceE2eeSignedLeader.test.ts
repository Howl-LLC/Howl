// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Signed voice-leader election primitives.
 *
 * Covers:
 *   - selectSignedLeader picks the lowest verified joinTimestamp
 *   - Ties broken by lex-smaller X25519 pub
 *   - Unverified (tampered) blobs are rejected
 *   - Mismatched channelId is rejected
 *   - All-unverified input → returns null (caller keeps its current key)
 *   - The join-blob signature is verified against the peer's client-pinned AIK
 *     (TOFU), never the raw server-supplied key — a server-substituted signing
 *     key fails the pin and the peer is dropped.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import {
  selectSignedLeader,
  type SignedVoiceParticipant,
  type TrustedSigningKeyResolver,
} from '../services/voiceE2ee';

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

/** In-memory TOFU resolver mirroring mlsGroupStore.pinOrVerifyAik: first sight
 *  pins the claimed key; a later sighting must match the pin or returns null. */
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

function makeSigned(
  userId: string,
  channelId: string,
  joinTimestamp: number,
  sigKp = nacl.sign.keyPair(),
  boxKp = nacl.box.keyPair(),
): SignedVoiceParticipant {
  const blob = {
    v: 1 as const,
    channelId,
    joinTimestamp,
    pub: toB64(boxKp.publicKey),
    sigPub: toB64(sigKp.publicKey),
  };
  const bytes = utf8Bytes(JSON.stringify(blob));
  const signature = toB64(nacl.sign.detached(bytes, sigKp.secretKey));
  return { userId, blob, signature };
}

describe('selectSignedLeader', () => {
  it('picks the participant with the lowest joinTimestamp', async () => {
    const resolve = makeTofuResolver();
    const alice = makeSigned('alice', 'ch-1', 100);
    const bob = makeSigned('bob', 'ch-1', 200);
    const carol = makeSigned('carol', 'ch-1', 300);
    expect(await selectSignedLeader('ch-1', [bob, carol, alice], resolve)).toBe('alice');
  });

  it('breaks ties by lex-smaller X25519 pub', async () => {
    const resolve = makeTofuResolver();
    const shared = 123;
    const a = makeSigned('a', 'ch-x', shared);
    const b = makeSigned('b', 'ch-x', shared);
    const winner = a.blob.pub < b.blob.pub ? 'a' : 'b';
    expect(await selectSignedLeader('ch-x', [a, b], resolve)).toBe(winner);
    // Reverse order → same winner
    expect(await selectSignedLeader('ch-x', [b, a], resolve)).toBe(winner);
  });

  it('ignores participants whose signature does not verify', async () => {
    const resolve = makeTofuResolver();
    const alice = makeSigned('alice', 'ch-1', 50);
    const bob = makeSigned('bob', 'ch-1', 100);
    // Corrupt alice's signature
    const tampered: SignedVoiceParticipant = { ...alice, signature: toB64(nacl.randomBytes(64)) };
    // Only bob's entry verifies
    expect(await selectSignedLeader('ch-1', [tampered, bob], resolve)).toBe('bob');
  });

  it('ignores participants whose blob.channelId mismatches', async () => {
    const resolve = makeTofuResolver();
    const alice = makeSigned('alice', 'wrong-channel', 10);
    const bob = makeSigned('bob', 'ch-1', 100);
    expect(await selectSignedLeader('ch-1', [alice, bob], resolve)).toBe('bob');
  });

  it('returns null when no participant has a valid signature', async () => {
    const resolve = makeTofuResolver();
    const alice = makeSigned('alice', 'ch-1', 50);
    const bob = makeSigned('bob', 'ch-1', 100);
    const tamperedA: SignedVoiceParticipant = { ...alice, signature: toB64(nacl.randomBytes(64)) };
    const tamperedB: SignedVoiceParticipant = { ...bob, signature: toB64(nacl.randomBytes(64)) };
    expect(await selectSignedLeader('ch-1', [tamperedA, tamperedB], resolve)).toBeNull();
  });

  it('empty input returns null', async () => {
    expect(await selectSignedLeader('ch-1', [], makeTofuResolver())).toBeNull();
  });

  it('a single verified participant becomes leader regardless of timestamp', async () => {
    const only = makeSigned('solo', 'ch-1', 99999);
    expect(await selectSignedLeader('ch-1', [only], makeTofuResolver())).toBe('solo');
  });

  it('attacker injecting a spoofed t=0 blob with bogus signature still loses to honest participants', async () => {
    const resolve = makeTofuResolver();
    const honest = makeSigned('alice', 'ch-1', 100);
    const spoofBoxKp = nacl.box.keyPair();
    const spoof: SignedVoiceParticipant = {
      userId: 'attacker',
      blob: {
        v: 1 as const,
        channelId: 'ch-1',
        joinTimestamp: 0,
        pub: toB64(spoofBoxKp.publicKey),
        sigPub: toB64(nacl.sign.keyPair().publicKey),
      },
      signature: toB64(nacl.randomBytes(64)), // bogus
    };
    expect(await selectSignedLeader('ch-1', [spoof, honest], resolve)).toBe('alice');
  });

  // The "bogus signature" test above only covers outsiders. The insider case is
  // harder: Mallory IS an authenticated member with valid DmKeyBundle keys on the
  // server, but signs a forged blob with a fresh throwaway Ed25519 keypair. Her
  // signature verifies under her declared sigPub (the throwaway pub), which would
  // let her claim leadership with any low joinTimestamp.
  //
  // Defense: the election pins/verifies each peer's AIK via the resolver and
  // verifies the blob against that pinned key, requiring `blob.sigPub === pinned`,
  // so swapping in a throwaway key fails verification.
  it('rejects insider who signs a forged low-timestamp blob with a throwaway sigKeypair', async () => {
    const resolve = makeTofuResolver();
    const honestBoxKp = nacl.box.keyPair();
    const honestSigKp = nacl.sign.keyPair();
    const honest = makeSigned('alice', 'ch-1', 100, honestSigKp, honestBoxKp);

    // Mallory's real DB keys — what the server would hand the other peers as the
    // claimed signingPublicKey / join-blob `pub` for authenticated user 'mallory'.
    const malloryBoxKp = nacl.box.keyPair();
    const malloryRealSigKp = nacl.sign.keyPair();

    // Mallory's attack: throwaway sig keypair to sign a forged t=0 blob.
    const throwawaySigKp = nacl.sign.keyPair();
    const forgedBlob = {
      v: 1 as const,
      channelId: 'ch-1',
      joinTimestamp: 0,
      pub: toB64(malloryBoxKp.publicKey),
      sigPub: toB64(throwawaySigKp.publicKey), // lies — not her real sigPub
    };
    const forgedSig = toB64(
      nacl.sign.detached(utf8Bytes(JSON.stringify(forgedBlob)), throwawaySigKp.secretKey),
    );
    const mallory: SignedVoiceParticipant = {
      userId: 'mallory',
      blob: forgedBlob,
      signature: forgedSig,
      signingPublicKey: toB64(malloryRealSigKp.publicKey), // server-claimed DB key
    };

    const alice: SignedVoiceParticipant = {
      ...honest,
      signingPublicKey: toB64(honestSigKp.publicKey),
    };

    // The resolver pins Mallory's real (claimed) AIK; her forged blob.sigPub ≠
    // that pinned key → verification fails → only alice's entry is considered.
    expect(await selectSignedLeader('ch-1', [mallory, alice], resolve)).toBe('alice');
  });

  // Legacy peers with no server `signingPublicKey` are pinned via the
  // self-declared `blob.sigPub` on first sight (TOFU) — accepted once, then
  // locked to that key for the rest of the session.
  it('TOFU-pins a peer that has no server signingPublicKey via blob.sigPub', async () => {
    const resolve = makeTofuResolver();
    const alice = makeSigned('alice', 'ch-1', 100); // no signingPublicKey field
    expect(await selectSignedLeader('ch-1', [alice], resolve)).toBe('alice');
  });

  // A server substitutes a previously-pinned peer's signing key (re-signing the
  // blob, since it controls the wire). The pin mismatch drops that peer, so it
  // can't be elected leader and the client never adopts its session key.
  it('rejects a peer whose signing key the server substitutes after the first pin', async () => {
    const resolve = makeTofuResolver();
    const aliceSigKp = nacl.sign.keyPair();
    const aliceBoxKp = nacl.box.keyPair();
    const alice = makeSigned('alice', 'ch-1', 100, aliceSigKp, aliceBoxKp);
    const honest: SignedVoiceParticipant = { ...alice, signingPublicKey: toB64(aliceSigKp.publicKey) };

    // First sighting pins alice's real AIK.
    expect(await selectSignedLeader('ch-1', [honest], resolve)).toBe('alice');

    // Malicious server swaps alice's signing key for an attacker key and re-signs
    // a forged t=0 blob with it (it controls both fields on the wire).
    const attackerSigKp = nacl.sign.keyPair();
    const forgedBlob = {
      v: 1 as const,
      channelId: 'ch-1',
      joinTimestamp: 0,
      pub: alice.blob.pub,
      sigPub: toB64(attackerSigKp.publicKey),
    };
    const forgedSig = toB64(
      nacl.sign.detached(utf8Bytes(JSON.stringify(forgedBlob)), attackerSigKp.secretKey),
    );
    const substituted: SignedVoiceParticipant = {
      userId: 'alice',
      blob: forgedBlob,
      signature: forgedSig,
      signingPublicKey: toB64(attackerSigKp.publicKey),
    };

    // Pin mismatch → alice dropped → no verified leader (client keeps its key).
    expect(await selectSignedLeader('ch-1', [substituted], resolve)).toBeNull();
  });
});
