// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HarnessClient } from './harnessClient.js';
import { parseRemovedLeaves, mapLeafIndicesToUserIds } from '../../src/mls/removeAuthz.js';
import { b64ToBuf } from '../../src/mls/serialization.js';

describe('removeAuthz: parse + map a real public Remove commit', () => {
  it('extracts the removed leaf and maps it to the removed userId', async () => {
    const aliceId = randomUUID(), aliceDev = randomUUID();
    const bobId = randomUUID(), bobDev = randomUUID();
    const alice = await HarnessClient.create(aliceId, aliceDev);
    await alice.createGroup();
    const bob = await HarnessClient.create(bobId, bobDev);
    await alice.commitAdd(await bob.publishKeyPackageB64()); // epoch 1: bob is a leaf

    // The pre-remove (epoch-1) GroupInfo still contains bob's leaf.
    const giBeforeRemove = await alice.publishGroupInfoB64();
    const rem = await alice.commitRemove([{ userId: bobId, deviceId: bobDev }], { wireAsPublicMessage: true });

    const parsed = parseRemovedLeaves(b64ToBuf(rem.commitB64));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.leaves).toHaveLength(1);

    const mapped = mapLeafIndicesToUserIds(b64ToBuf(giBeforeRemove), parsed.leaves);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error('map failed');
    expect(mapped.userIds).toEqual([bobId]);
  });

  it('returns no leaves for a commit with no Remove proposals (public Add)', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.createGroup();
    const bob = await HarnessClient.create(randomUUID(), randomUUID());
    const add = await alice.commitAdd(await bob.publishKeyPackageB64(), { wireAsPublicMessage: true });
    const parsed = parseRemovedLeaves(b64ToBuf(add.commitB64));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.leaves).toEqual([]);
  });

  it('rejects a private commit (not_public)', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.createGroup();
    const bob = await HarnessClient.create(randomUUID(), randomUUID());
    const add = await alice.commitAdd(await bob.publishKeyPackageB64()); // default private
    const parsed = parseRemovedLeaves(b64ToBuf(add.commitB64));
    expect(parsed).toEqual({ ok: false, reason: 'not_public' });
  });
});

describe('removeAuthz: map-side failure modes', () => {
  it('fails closed (leaf_not_found) for an out-of-bounds leaf index', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.createGroup();
    const bob = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.commitAdd(await bob.publishKeyPackageB64()); // epoch 1: 2 leaves in the tree
    const groupInfoB64 = await alice.publishGroupInfoB64();

    const mapped = mapLeafIndicesToUserIds(b64ToBuf(groupInfoB64), [999]);
    expect(mapped).toEqual({ ok: false, reason: 'leaf_not_found' });
  });
});
