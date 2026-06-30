// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HarnessClient } from './harnessClient.js';

describe('HarnessClient (ts-mls driver)', () => {
  it('founder creates a group at epoch 0 and adds a member, who joins via Welcome', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    const bob = await HarnessClient.create(randomUUID(), randomUUID());

    const bobKpB64 = await bob.publishKeyPackageB64();
    const groupId = await alice.createGroup();
    expect(await alice.currentEpoch()).toBe(0n);

    const { commitB64, welcomeB64, newEpoch } = await alice.commitAdd(bobKpB64);
    expect(newEpoch).toBe(1n);

    await bob.joinFromWelcome(welcomeB64);
    expect(await bob.currentEpoch()).toBe(1n);

    // Application message round-trips after the add.
    const ct = await bob.encrypt('hi alice');
    expect(await alice.decrypt(ct)).toBe('hi alice');
    // alice must also process bob's commit is N/A — alice already advanced via commitAdd.
  });

  it('external-commit self-join consumes published GroupInfo', async () => {
    const alice = await HarnessClient.create(randomUUID(), randomUUID());
    await alice.createGroup();
    const giB64 = await alice.publishGroupInfoB64();

    const carol = await HarnessClient.create(randomUUID(), randomUUID());
    const { externalCommitB64 } = await carol.joinExternal(giB64);
    await alice.processCommit(externalCommitB64);
    expect(await carol.currentEpoch()).toBe(await alice.currentEpoch());
  });
});
