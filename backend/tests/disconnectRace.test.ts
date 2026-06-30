// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for race-safe disconnect cleanup.
 *
 * Verifies that when multiple sockets of the same user disconnect
 * simultaneously (same event-loop tick), exactly one socket runs
 * voice/DM-call cleanup — preventing orphaned participant rows in Redis.
 *
 * Uses the Redis-backed SETNX lock (`acquireDisconnectCleanupLock` /
 * `releaseDisconnectCleanupLock`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireDisconnectCleanupLock,
  releaseDisconnectCleanupLock,
} from '../src/redis.js';

// Deterministic IDs for test isolation — each test uses a unique suffix
// to avoid cross-test lock collisions (locks have a 5s TTL that may
// outlive individual tests).
let testSeq = 0;
function uniqueId(prefix: string): string {
  testSeq++;
  return `${prefix}-${Date.now()}-${testSeq}`;
}

describe('disconnect cleanup lock (race fix)', () => {
  let userId: string;
  let voiceChannelId: string;
  let dmCallId: string;

  beforeEach(() => {
    userId = uniqueId('user');
    voiceChannelId = uniqueId('voice-ch');
    dmCallId = uniqueId('dm-call');
  });

  // Test 1: simultaneous voice disconnect — exactly one cleanup wins
  it('grants the voice cleanup lock to exactly one of N concurrent acquirers', async () => {
    const roomKey = `voice:${voiceChannelId}`;

    // Simulate 3 sockets racing to acquire the lock concurrently
    const results = await Promise.all([
      acquireDisconnectCleanupLock(roomKey, userId),
      acquireDisconnectCleanupLock(roomKey, userId),
      acquireDisconnectCleanupLock(roomKey, userId),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);

    // Clean up
    await releaseDisconnectCleanupLock(roomKey, userId);
  });

  // Test 2: simultaneous DM-call disconnect — exactly one cleanup wins
  it('grants the DM call cleanup lock to exactly one of N concurrent acquirers', async () => {
    const roomKey = `dm-call:${dmCallId}`;

    const results = await Promise.all([
      acquireDisconnectCleanupLock(roomKey, userId),
      acquireDisconnectCleanupLock(roomKey, userId),
      acquireDisconnectCleanupLock(roomKey, userId),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);

    await releaseDisconnectCleanupLock(roomKey, userId);
  });

  // Test 3: 1 disconnect, 2 remain — lock is available but the
  //    `stillHeld` fast-path in the actual disconnect handler skips the
  //    lock entirely. Here we verify the lock doesn't interfere: a single
  //    acquire succeeds, proving the lock path is a no-op for the common
  // case where only one socket tries to clean up.
  it('single socket acquires the lock successfully (no contention)', async () => {
    const roomKey = `voice:${voiceChannelId}`;

    const acquired = await acquireDisconnectCleanupLock(roomKey, userId);
    expect(acquired).toBe(true);

    await releaseDisconnectCleanupLock(roomKey, userId);
  });

  // Test 4: after release, a new acquire succeeds (quick reconnect)
  it('allows re-acquire after explicit release', async () => {
    const roomKey = `voice:${voiceChannelId}`;

    const first = await acquireDisconnectCleanupLock(roomKey, userId);
    expect(first).toBe(true);

    await releaseDisconnectCleanupLock(roomKey, userId);

    const second = await acquireDisconnectCleanupLock(roomKey, userId);
    expect(second).toBe(true);

    await releaseDisconnectCleanupLock(roomKey, userId);
  });

  // Test 5: lock scoping — different users don't interfere
  it('grants independent locks for different users on the same channel', async () => {
    const roomKey = `voice:${voiceChannelId}`;
    const user2 = uniqueId('user');

    const [acq1, acq2] = await Promise.all([
      acquireDisconnectCleanupLock(roomKey, userId),
      acquireDisconnectCleanupLock(roomKey, user2),
    ]);

    expect(acq1).toBe(true);
    expect(acq2).toBe(true);

    await Promise.all([
      releaseDisconnectCleanupLock(roomKey, userId),
      releaseDisconnectCleanupLock(roomKey, user2),
    ]);
  });

  // Test 6: lock scoping — same user, different channels
  it('grants independent locks for the same user on different channels', async () => {
    const room1 = `voice:${voiceChannelId}`;
    const room2 = `voice:${uniqueId('voice-ch')}`;

    const [acq1, acq2] = await Promise.all([
      acquireDisconnectCleanupLock(room1, userId),
      acquireDisconnectCleanupLock(room2, userId),
    ]);

    expect(acq1).toBe(true);
    expect(acq2).toBe(true);

    await Promise.all([
      releaseDisconnectCleanupLock(room1, userId),
      releaseDisconnectCleanupLock(room2, userId),
    ]);
  });

  // Test 7: without release, lock blocks re-acquire (TTL-based)
  //    This proves a crashed socket's lock will block others until the
  //    5-second TTL expires. We can't wait 5s in a fast test, so we
  //    simply verify the second acquire is blocked.
  it('blocks a second acquire while the lock is held (crash scenario)', async () => {
    const roomKey = `voice:${voiceChannelId}`;

    const first = await acquireDisconnectCleanupLock(roomKey, userId);
    expect(first).toBe(true);

    // Second acquire without release — should be blocked
    const second = await acquireDisconnectCleanupLock(roomKey, userId);
    expect(second).toBe(false);

    // Cleanup for test isolation
    await releaseDisconnectCleanupLock(roomKey, userId);
  });
});
