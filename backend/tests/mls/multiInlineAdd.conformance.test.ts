// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HarnessClient } from './harnessClient.js';

// Prerequisite conformance check. Proves ts-mls createCommit accepts N inline Add
// proposals in ONE Commit producing ONE Welcome that all N joiners can join.
// If this suite FAILS, createGroupDmGroup / commitAddMembersWithRebase must use
// the sequential single-Add fallback (one addMembers([kp]) + one submitCommit per
// member).
describe('ts-mls batches N inline Add proposals into one Commit/Welcome', () => {
  it('N=15: founder adds 15 members in ONE commit; all 15 join via the ONE Welcome', async () => {
    const N = 15;
    const founder = await HarnessClient.create(randomUUID(), randomUUID());
    const groupId = await founder.createGroup();
    expect(groupId).toEqual(expect.any(String));
    expect(await founder.currentEpoch()).toBe(0n);

    const members: HarnessClient[] = [];
    const kpB64List: string[] = [];
    for (let i = 0; i < N; i++) {
      const m = await HarnessClient.create(randomUUID(), randomUUID());
      // publishKeyPackageB64 sets each member's lastKeyPair, which joinFromWelcome
      // needs. The members do NOT generate any other key between publish and join.
      kpB64List.push(await m.publishKeyPackageB64());
      members.push(m);
    }

    // ONE batched commit: N Add proposals -> ONE Commit + ONE Welcome.
    const { commitB64, welcomeB64, newEpoch } = await founder.commitAddMany(kpB64List);
    expect(commitB64).toEqual(expect.any(String));
    expect(welcomeB64).toEqual(expect.any(String));
    // A single Add commit advances the epoch exactly once (0 -> 1), regardless of N.
    expect(newEpoch).toBe(1n);
    expect(await founder.currentEpoch()).toBe(1n);

    // Every one of the N members joins from the SAME Welcome.
    for (const m of members) {
      await m.joinFromWelcome(welcomeB64);
      expect(await m.currentEpoch()).toBe(1n);
    }

    // App-message round-trip across the freshly-built N+1-leaf tree: the last
    // member encrypts, the founder decrypts (proves shared epoch-1 secrets).
    const ct = await members[N - 1].encrypt('hello from the last joiner');
    expect(await founder.decrypt(ct)).toBe('hello from the last joiner');
  }, 60000);
});
