// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Pure in-memory regression tests for the server-side voice/stage E2EE
 * leader-tracking helpers.
 *
 * Runs against the redis.ts / routes/stages.ts in-memory fallback path so it
 * doesn't need Postgres or a live Redis — the same code paths exercised in
 * single-instance dev mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  addVoiceParticipant,
  getVoiceParticipants,
  removeVoiceParticipant,
  publicVoiceParticipant,
} from '../src/redis.js';
import { setStageLeader, getStageLeader, clearStageState, addToSet, removeFromSet } from '../src/routes/stages.js';
import {
  scheduleVoiceE2eeRotate,
  rotateStageLeaderAndKey,
  E2EE_ROTATION_DEBOUNCE_MS,
} from '../src/services/voiceE2eeRotation.js';

const CHAN = '11111111-1111-1111-1111-111111111111';

/**
 * Minimal Socket.IO `io` test double — records `(room, event, payload)` tuples
 * emitted via `io.to(room).emit(event, payload)`. The rotation helpers only
 * use this narrow surface.
 */
type Emitted = { room: string; event: string; payload: unknown };
function fakeIo(): { io: any; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const io = {
    to(room: string) {
      return { emit(event: string, payload: unknown) { emitted.push({ room, event, payload }); } };
    },
  };
  return { io, emitted };
}

async function wipeVoice(channelId: string): Promise<void> {
  const all = await getVoiceParticipants(channelId);
  for (const p of all) await removeVoiceParticipant(channelId, p.userId);
}

describe('getVoiceParticipants sorts by server joinedAt, not hash iteration', () => {
  beforeEach(async () => { await wipeVoice(CHAN); });

  it('oldest joiner appears at index 0 regardless of insertion order', async () => {
    // Insert in "newest first" order — a hash iteration would then present
    // them that way too, which is the bug this guards against.
    await addVoiceParticipant(CHAN, 'charlie', { username: 'c', joinedAt: 3000 });
    await addVoiceParticipant(CHAN, 'alice', { username: 'a', joinedAt: 1000 });
    await addVoiceParticipant(CHAN, 'bob', { username: 'b', joinedAt: 2000 });

    const ordered = await getVoiceParticipants(CHAN);
    expect(ordered.map(p => p.userId)).toEqual(['alice', 'bob', 'charlie']);
  });

  it('entries without joinedAt (legacy upgrade window) sort before stamped entries', async () => {
    await addVoiceParticipant(CHAN, 'stamped', { username: 's', joinedAt: 5000 });
    await addVoiceParticipant(CHAN, 'legacy', { username: 'l' }); // no joinedAt

    const ordered = await getVoiceParticipants(CHAN);
    expect(ordered[0].userId).toBe('legacy');
  });
});

describe('publicVoiceParticipant strips internal fields', () => {
  it('removes capabilities and joinedAt, keeps signingPublicKey', () => {
    const wire = publicVoiceParticipant({
      userId: 'u',
      username: 'u',
      joinedAt: 123,
      capabilities: ['sframe.v1'],
      signingPublicKey: 'pub==',
    });
    expect(wire).not.toHaveProperty('capabilities');
    expect(wire).not.toHaveProperty('joinedAt');
    expect(wire.signingPublicKey).toBe('pub==');
  });
});

describe('stage leader Redis helpers', () => {
  beforeEach(async () => { await clearStageState(CHAN); });

  it('setStageLeader → getStageLeader round-trips', async () => {
    await setStageLeader(CHAN, 'host-user');
    expect(await getStageLeader(CHAN)).toBe('host-user');
  });

  it('getStageLeader returns null after clearStageState', async () => {
    await setStageLeader(CHAN, 'host-user');
    await clearStageState(CHAN);
    expect(await getStageLeader(CHAN)).toBeNull();
  });

  it('setStageLeader overwrites the previous value (rotation path)', async () => {
    await setStageLeader(CHAN, 'host-1');
    await setStageLeader(CHAN, 'host-2');
    expect(await getStageLeader(CHAN)).toBe('host-2');
  });
});

describe('scheduleVoiceE2eeRotate (shared voice rotate helper)', () => {
  beforeEach(async () => {
    await wipeVoice(CHAN);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('emits voice-e2ee-rotate to the channel with the oldest remaining participant after debounce', async () => {
    // Two participants remain after a departure; alice is oldest (joinedAt lower).
    await addVoiceParticipant(CHAN, 'bob', { username: 'b', joinedAt: 2000 });
    await addVoiceParticipant(CHAN, 'alice', { username: 'a', joinedAt: 1000 });

    const { io, emitted } = fakeIo();
    scheduleVoiceE2eeRotate(io, CHAN, true);

    // Nothing emitted synchronously — it's debounced.
    expect(emitted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(E2EE_ROTATION_DEBOUNCE_MS + 10);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(`voice:${CHAN}`);
    expect(emitted[0].event).toBe('voice-e2ee-rotate');
    expect(emitted[0].payload).toMatchObject({ channelId: CHAN, newLeaderUserId: 'alice' });
  });

  it('coalesces a burst of departures into a single rotate (debounce re-arm)', async () => {
    await addVoiceParticipant(CHAN, 'alice', { username: 'a', joinedAt: 1000 });

    const { io, emitted } = fakeIo();
    scheduleVoiceE2eeRotate(io, CHAN, true);
    await vi.advanceTimersByTimeAsync(500);
    scheduleVoiceE2eeRotate(io, CHAN, true); // second departure re-arms the timer
    await vi.advanceTimersByTimeAsync(500);
    expect(emitted).toHaveLength(0); // first window was cancelled
    await vi.advanceTimersByTimeAsync(E2EE_ROTATION_DEBOUNCE_MS + 10);
    expect(emitted).toHaveLength(1);
  });

  it('does not emit when the room emptied (participantsRemain=false cancels pending)', async () => {
    await addVoiceParticipant(CHAN, 'alice', { username: 'a', joinedAt: 1000 });
    const { io, emitted } = fakeIo();
    scheduleVoiceE2eeRotate(io, CHAN, true);   // arm
    scheduleVoiceE2eeRotate(io, CHAN, false);  // last participant left → cancel
    await vi.advanceTimersByTimeAsync(E2EE_ROTATION_DEBOUNCE_MS + 10);
    expect(emitted).toHaveLength(0);
  });

  it('emits nothing if all participants are gone by the time the debounce fires', async () => {
    await addVoiceParticipant(CHAN, 'alice', { username: 'a', joinedAt: 1000 });
    const { io, emitted } = fakeIo();
    scheduleVoiceE2eeRotate(io, CHAN, true);
    // Everyone leaves during the debounce window.
    await removeVoiceParticipant(CHAN, 'alice');
    await vi.advanceTimersByTimeAsync(E2EE_ROTATION_DEBOUNCE_MS + 10);
    expect(emitted).toHaveLength(0);
  });
});

describe('rotateStageLeaderAndKey (shared stage rotate helper)', () => {
  beforeEach(async () => { await clearStageState(CHAN); });

  it('advances the leader pointer to the first remaining speaker and emits stage-e2ee-rotate', async () => {
    // No active StageSession row (getStageSessionId → null), so the helper
    // falls back to the first remaining speaker without touching Postgres.
    await addToSet(CHAN, 'speakers', 'speaker-1');
    await addToSet(CHAN, 'speakers', 'speaker-2');

    const { io, emitted } = fakeIo();
    const newHost = await rotateStageLeaderAndKey(io, CHAN);

    // Set membership ordering isn't guaranteed, but the chosen host must be one
    // of the remaining speakers AND must match the broadcast + the leader pointer.
    expect(['speaker-1', 'speaker-2']).toContain(newHost);
    expect(await getStageLeader(CHAN)).toBe(newHost);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(`channel:${CHAN}`);
    expect(emitted[0].event).toBe('stage-e2ee-rotate');
    expect(emitted[0].payload).toMatchObject({ channelId: CHAN, newHostUserId: newHost });
  });

  it('is a no-op when no speakers remain (returns null, emits nothing, leaves pointer untouched)', async () => {
    await setStageLeader(CHAN, 'departed-host');
    // departing host was the only speaker; caller already removed them.
    const { io, emitted } = fakeIo();
    const newHost = await rotateStageLeaderAndKey(io, CHAN);
    expect(newHost).toBeNull();
    expect(emitted).toHaveLength(0);
    // Pointer unchanged — caller decides whether to clear it (session may end).
    expect(await getStageLeader(CHAN)).toBe('departed-host');
  });

  it('advances the pointer BEFORE emitting (no window where a racing distribute sees the old leader)', async () => {
    await addToSet(CHAN, 'speakers', 'next-host');
    let leaderAtEmit: string | null = null;
    const io = {
      to(room: string) {
        return {
          async emit() {
            // At emit time the pointer must already be the new host.
            leaderAtEmit = await getStageLeader(CHAN);
          },
        };
      },
    } as any;
    await rotateStageLeaderAndKey(io, CHAN);
    expect(leaderAtEmit).toBe('next-host');
  });

  it('does not re-add a departed speaker (reads the live speaker set, not a stale snapshot)', async () => {
    await addToSet(CHAN, 'speakers', 'host');
    await addToSet(CHAN, 'speakers', 'co-host');
    // Host abruptly leaves: caller removes them first, THEN calls the helper.
    await removeFromSet(CHAN, 'speakers', 'host');
    const { io } = fakeIo();
    const newHost = await rotateStageLeaderAndKey(io, CHAN);
    expect(newHost).toBe('co-host');
  });
});
