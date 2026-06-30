// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { redis } from './redis.js';
import { logger } from './logger.js';

export type OtrEnvelope = {
  clientMsgId: string;
  authorId: string;
  dmChannelId: string;
  mlsGroupId: string;
  ciphertext: string;
  createdAt: number; // epoch ms, server-stamped
};

// Bounded + TTL'd. The whole-list EXPIRE is refreshed on each enqueue; per-item
// expiry is approximated by pruning createdAt < now-TTL on pull.
const OTR_QUEUE_MAX = Number(process.env.OTR_QUEUE_MAX ?? 100);
const OTR_QUEUE_TTL_SEC = Number(process.env.OTR_QUEUE_TTL_SEC ?? 7 * 24 * 3600);
const MEM_MAX_RECIPIENTS = 50_000;

const mem = new Map<string, OtrEnvelope[]>();
const key = (recipientId: string) => `otrq:${recipientId}`;
const isExpired = (e: OtrEnvelope, now: number) => e.createdAt < now - OTR_QUEUE_TTL_SEC * 1000;

export async function enqueueOtr(recipientId: string, env: OtrEnvelope): Promise<void> {
  if (redis) {
    try {
      const k = key(recipientId);
      const pipe = redis.pipeline();
      pipe.rpush(k, JSON.stringify(env));
      pipe.ltrim(k, -OTR_QUEUE_MAX, -1);
      pipe.expire(k, OTR_QUEUE_TTL_SEC);
      await pipe.exec();
      return;
    } catch (err) {
      logger.warn({ err, recipientId }, 'otrQueue enqueue: redis failed, using memory');
    }
  }
  let arr = mem.get(recipientId);
  if (!arr) {
    if (mem.size >= MEM_MAX_RECIPIENTS) {
      const oldest = mem.keys().next().value;
      if (oldest !== undefined) mem.delete(oldest);
    }
    arr = [];
    mem.set(recipientId, arr);
  }
  arr.push(env);
  if (arr.length > OTR_QUEUE_MAX) arr.splice(0, arr.length - OTR_QUEUE_MAX);
}

export async function pullOtr(recipientId: string): Promise<OtrEnvelope[]> {
  const now = Date.now();
  if (redis) {
    try {
      const k = key(recipientId);
      const raw = await redis.lrange(k, 0, -1);
      const parsed: OtrEnvelope[] = [];
      const expiredIds: string[] = [];
      for (const s of raw) {
        try {
          const e = JSON.parse(s) as OtrEnvelope;
          if (isExpired(e, now)) expiredIds.push(s);
          else parsed.push(e);
        } catch { /* drop unparseable */ }
      }
      if (expiredIds.length) {
        const pipe = redis.pipeline();
        for (const s of expiredIds) pipe.lrem(k, 1, s);
        await pipe.exec();
      }
      return parsed;
    } catch (err) {
      logger.warn({ err, recipientId }, 'otrQueue pull: redis failed, using memory');
    }
  }
  const arr = (mem.get(recipientId) ?? []).filter((e) => !isExpired(e, now));
  mem.set(recipientId, arr);
  return [...arr];
}

export async function ackOtr(recipientId: string, clientMsgId: string): Promise<void> {
  if (redis) {
    try {
      const k = key(recipientId);
      const raw = await redis.lrange(k, 0, -1);
      const match = raw.find((s) => {
        try { return (JSON.parse(s) as OtrEnvelope).clientMsgId === clientMsgId; } catch { return false; }
      });
      if (match) await redis.lrem(k, 1, match);
      return;
    } catch (err) {
      logger.warn({ err, recipientId }, 'otrQueue ack: redis failed, using memory');
    }
  }
  const arr = mem.get(recipientId);
  if (arr) mem.set(recipientId, arr.filter((e) => e.clientMsgId !== clientMsgId));
}

// Test-only reset of the in-memory fallback.
export function __resetOtrQueueForTest(): void {
  mem.clear();
}
