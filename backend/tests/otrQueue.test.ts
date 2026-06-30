// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueOtr, pullOtr, ackOtr, __resetOtrQueueForTest } from '../src/otrQueue';

const mk = (clientMsgId: string, createdAt = Date.now()) => ({
  clientMsgId, authorId: 'a', dmChannelId: 'c', mlsGroupId: 'g', ciphertext: 'x', createdAt,
});

describe('otrQueue (in-memory fallback)', () => {
  beforeEach(() => __resetOtrQueueForTest());
  it('enqueues and pulls in order (non-destructive)', async () => {
    await enqueueOtr('u1', mk('m1'));
    await enqueueOtr('u1', mk('m2'));
    expect((await pullOtr('u1')).map((e) => e.clientMsgId)).toEqual(['m1', 'm2']);
    expect((await pullOtr('u1')).length).toBe(2); // pull does not delete
  });
  it('ack removes one item by clientMsgId', async () => {
    await enqueueOtr('u1', mk('m1'));
    await enqueueOtr('u1', mk('m2'));
    await ackOtr('u1', 'm1');
    expect((await pullOtr('u1')).map((e) => e.clientMsgId)).toEqual(['m2']);
  });
  it('prunes items older than the TTL on pull', async () => {
    await enqueueOtr('u1', mk('old', Date.now() - 8 * 24 * 3600 * 1000)); // > 7d
    await enqueueOtr('u1', mk('fresh'));
    expect((await pullOtr('u1')).map((e) => e.clientMsgId)).toEqual(['fresh']);
  });
  it('bounds the queue length (LTRIM equivalent)', async () => {
    for (let i = 0; i < 120; i++) await enqueueOtr('u1', mk(`m${i}`));
    const all = await pullOtr('u1');
    expect(all.length).toBeLessThanOrEqual(100);
    expect(all[all.length - 1].clientMsgId).toBe('m119'); // newest retained
  });
});
