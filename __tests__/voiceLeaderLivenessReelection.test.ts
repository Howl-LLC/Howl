// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * client-side liveness backstop re-election semantics.
 *
 * When the verified voice leader departs and the server's voice-e2ee-rotate
 * never arrives, useVoiceE2ee re-runs selectSignedLeader against the cached
 * roster MINUS the departed leader and either assumes leadership or requests
 * the key from the newly-elected leader. This pins that election step (the
 * load-bearing decision the backstop makes) without booting React + sockets.
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

function makeSigned(userId: string, channelId: string, joinTimestamp: number): SignedVoiceParticipant {
  const sigKp = nacl.sign.keyPair();
  const boxKp = nacl.box.keyPair();
  const blob = {
    v: 1 as const,
    channelId,
    joinTimestamp,
    pub: toB64(boxKp.publicKey),
    sigPub: toB64(sigKp.publicKey),
  };
  const signature = toB64(nacl.sign.detached(utf8Bytes(JSON.stringify(blob)), sigKp.secretKey));
  return { userId, blob, signature, signingPublicKey: toB64(sigKp.publicKey) };
}

describe('leader-departure re-election', () => {
  const CH = 'ch-live';

  it('re-elects the next-oldest verified participant after excluding the departed leader', async () => {
    const resolve = makeTofuResolver();
    const leader = makeSigned('leader', CH, 100);   // current verified leader
    const second = makeSigned('second', CH, 200);
    const third = makeSigned('third', CH, 300);

    // Sanity: leader wins the full roster.
    expect(await selectSignedLeader(CH, [leader, second, third], resolve)).toBe('leader');

    // Backstop step: drop the departed leader, re-elect → next-oldest wins.
    const remaining = [leader, second, third].filter((p) => p.userId !== 'leader');
    expect(await selectSignedLeader(CH, remaining, resolve)).toBe('second');
  });

  it('elects self when the local user is the next-oldest after the leader departs', async () => {
    const resolve = makeTofuResolver();
    const leader = makeSigned('leader', CH, 100);
    const me = makeSigned('me', CH, 150);
    const remaining = [leader, me].filter((p) => p.userId !== 'leader');
    expect(await selectSignedLeader(CH, remaining, resolve)).toBe('me');
  });

  it('returns null when no verifiable successor remains (backstop must NOT adopt an unverified key)', async () => {
    const resolve = makeTofuResolver();
    const leader = makeSigned('leader', CH, 100);
    // Only an unverifiable (tampered) peer remains besides the leader.
    const tampered: SignedVoiceParticipant = {
      ...makeSigned('ghost', CH, 200),
      signature: toB64(nacl.randomBytes(64)),
    };
    const remaining = [leader, tampered].filter((p) => p.userId !== 'leader');
    expect(await selectSignedLeader(CH, remaining, resolve)).toBeNull();
  });

  it('does NOT elect a ghost: a non-leader who left before the leader must be pruned from the cached roster', async () => {
    const resolve = makeTofuResolver();
    const leader = makeSigned('leader', CH, 100);   // current verified leader
    const ghost = makeSigned('ghost', CH, 200);     // a NON-leader, departs FIRST
    const me = makeSigned('me', CH, 300);           // local user

    // The hazard: if a non-leader departure does NOT prune the cached roster,
    // the later leader-departure backstop builds its candidate set from the
    // stale roster and selectSignedLeader picks the OLDER ghost — an already
    // departed user that can never answer a request-key, wedging the client.
    const staleRoster = [leader, ghost, me].filter((p) => p.userId !== 'leader');
    expect(await selectSignedLeader(CH, staleRoster, resolve)).toBe('ghost'); // would-be wedge

    // The fix (handleVoiceUserLeft prunes EVERY departure): by the time the
    // leader leaves, ghost is already gone, so the candidate set is the only
    // present, verifiable successor.
    const prunedRoster = [leader, ghost, me]
      .filter((p) => p.userId !== 'ghost')    // ghost's earlier departure pruned it
      .filter((p) => p.userId !== 'leader');  // backstop excludes the departed leader
    expect(await selectSignedLeader(CH, prunedRoster, resolve)).toBe('me');
  });
});
