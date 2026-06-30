// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HarnessClient } from './harnessClient.js';
import { parseAddedLeaves } from '../../src/mls/removeAuthz.js';
import { b64ToBuf } from '../../src/mls/serialization.js';

describe('addAuthz: parse a real public Add commit', () => {
  it('extracts the added userId from a public Add commit', async () => {
    const aliceId = randomUUID(), bobId = randomUUID();
    const alice = await HarnessClient.create(aliceId, randomUUID());
    await alice.createGroup();
    const bob = await HarnessClient.create(bobId, randomUUID());
    const add = await alice.commitAdd(await bob.publishKeyPackageB64(), { wireAsPublicMessage: true });

    const parsed = parseAddedLeaves(b64ToBuf(add.commitB64));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.userIds).toEqual([bobId]);
  });

  it('returns no userIds for a public Remove commit (no Add proposals)', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.createGroup();
    const bobId = randomUUID(), bobDev = randomUUID();
    const bob = await HarnessClient.create(bobId, bobDev);
    await alice.commitAdd(await bob.publishKeyPackageB64()); // epoch 1: bob is a leaf
    const rem = await alice.commitRemove([{ userId: bobId, deviceId: bobDev }], { wireAsPublicMessage: true });
    const parsed = parseAddedLeaves(b64ToBuf(rem.commitB64));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.userIds).toEqual([]);
  });

  it('rejects a private commit (not_public)', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.createGroup();
    const bob = await HarnessClient.create(randomUUID(), randomUUID());
    const add = await alice.commitAdd(await bob.publishKeyPackageB64()); // default private
    expect(parseAddedLeaves(b64ToBuf(add.commitB64))).toEqual({ ok: false, reason: 'not_public' });
  });
});
