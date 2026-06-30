// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import { logger } from '../logger.js';
import {
  addStreamViewer, removeStreamViewer, getStreamViewersPage,
  isInVoiceChannel, isInDmCall,
} from '../redis.js';
import {
  parseSocketPayload, viewerSubscribePayload, viewerUnsubscribePayload, viewerListPayload,
} from '../socketSchemas.js';
import { checkViewerRateLimit, cappedMapSet } from './infrastructure.js';
import { isInSet } from '../routes/stages.js';

const log = logger.child({ module: 'viewers' });

/** Per-streamKey coalescing buffer. Flushes every 100 ms.
 *  Entries are short-lived (auto-deleted after 100ms), but capped
 *  defensively by convention. */
interface CoalesceEntry { add: Set<string>; remove: Set<string>; timer: NodeJS.Timeout }
const MAX_COALESCE_BUFFERS = 10_000;
const coalesceBuffers = new Map<string, CoalesceEntry>();

/**
 * Map context kind to the socket.io room name used by the existing
 * voice / DM call / stage handlers. These must match the room names
 * that users join when entering each call context.
 */
function streamRoomName(ctx: { kind: string; scopeId: string }): string {
  switch (ctx.kind) {
    case 'voice': return `voice:${ctx.scopeId}`;
    case 'dm':    return `dm-call:${ctx.scopeId}`;
    case 'stage': return `channel:${ctx.scopeId}`;
    default:      throw new Error(`Unknown context kind: ${ctx.kind}`);
  }
}

async function isInContext(
  userId: string, ctx: { kind: string; scopeId: string },
): Promise<boolean> {
  switch (ctx.kind) {
    case 'voice': return isInVoiceChannel(ctx.scopeId, userId);
    case 'dm':    return isInDmCall(ctx.scopeId, userId);
    case 'stage': {
      // Stage membership: user is in either the audience or speakers set
      const [inAudience, inSpeakers] = await Promise.all([
        isInSet(ctx.scopeId, 'audience', userId),
        isInSet(ctx.scopeId, 'speakers', userId),
      ]);
      return inAudience || inSpeakers;
    }
    default:      return false;
  }
}

function queueBroadcast(
  io: SocketContext['io'], ctx: { kind: string; scopeId: string },
  streamOwnerId: string, streamType: string,
  delta: { add?: string[]; remove?: string[] },
): void {
  const key = `${ctx.kind}:${ctx.scopeId}:${streamOwnerId}:${streamType}`;
  let entry = coalesceBuffers.get(key);
  if (!entry) {
    entry = {
      add: new Set(),
      remove: new Set(),
      timer: setTimeout(() => flushBroadcast(io, ctx, streamOwnerId, streamType), 100),
    };
    // Use cappedMapSet for LRU eviction; clear evicted timer to avoid leak.
    // cappedMapSet evicts the oldest entry when at cap, but we need to clear its timer first.
    if (coalesceBuffers.size >= MAX_COALESCE_BUFFERS && !coalesceBuffers.has(key)) {
      const oldestKey = coalesceBuffers.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = coalesceBuffers.get(oldestKey);
        if (evicted) clearTimeout(evicted.timer);
      }
    }
    cappedMapSet(coalesceBuffers, key, entry, MAX_COALESCE_BUFFERS);
  }
  for (const v of delta.add ?? []) {
    entry.add.add(v);
    entry.remove.delete(v);
  }
  for (const v of delta.remove ?? []) {
    entry.remove.add(v);
    entry.add.delete(v);
  }
}

function flushBroadcast(
  io: SocketContext['io'], ctx: { kind: string; scopeId: string },
  streamOwnerId: string, streamType: string,
): void {
  const key = `${ctx.kind}:${ctx.scopeId}:${streamOwnerId}:${streamType}`;
  const entry = coalesceBuffers.get(key);
  if (!entry) return;
  coalesceBuffers.delete(key);
  const payload: { context: typeof ctx; streamOwnerId: string; streamType: string; add?: string[]; remove?: string[] } = {
    context: ctx, streamOwnerId, streamType,
  };
  if (entry.add.size) payload.add = Array.from(entry.add);
  if (entry.remove.size) payload.remove = Array.from(entry.remove);
  if (payload.add || payload.remove) {
    io.to(streamRoomName(ctx)).emit('viewer:changed', payload);
  }
}

export function registerViewerHandlers(ctx: SocketContext): void {
  const { socket, userId, io } = ctx;

  socket.on('viewer:subscribe', async (data: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
    try {
      const payload = parseSocketPayload(viewerSubscribePayload, data);
      if (!payload) { ack?.({ ok: false, error: 'invalid payload' }); return; }
      if (!(await checkViewerRateLimit(userId))) { ack?.({ ok: false, error: 'rate limited' }); return; }
      if (!(await isInContext(userId, payload.context))) { ack?.({ ok: false, error: 'not in context' }); return; }

      await addStreamViewer(payload.context, payload.streamOwnerId, payload.streamType, userId);
      queueBroadcast(io, payload.context, payload.streamOwnerId, payload.streamType, { add: [userId] });
      ack?.({ ok: true });
    } catch (err) {
      log.error({ err }, 'viewer:subscribe failed');
      ack?.({ ok: false, error: 'internal error' });
    }
  });

  socket.on('viewer:unsubscribe', async (data: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
    try {
      const payload = parseSocketPayload(viewerUnsubscribePayload, data);
      if (!payload) { ack?.({ ok: false, error: 'invalid payload' }); return; }
      if (!(await checkViewerRateLimit(userId))) { ack?.({ ok: false, error: 'rate limited' }); return; }

      await removeStreamViewer(payload.context, payload.streamOwnerId, payload.streamType, userId);
      queueBroadcast(io, payload.context, payload.streamOwnerId, payload.streamType, { remove: [userId] });
      ack?.({ ok: true });
    } catch (err) {
      log.error({ err }, 'viewer:unsubscribe failed');
      ack?.({ ok: false, error: 'internal error' });
    }
  });

  socket.on('viewer:list', async (data: unknown, ack?: (r: { ok: boolean; viewers?: string[]; nextPage?: number; error?: string }) => void) => {
    try {
      const payload = parseSocketPayload(viewerListPayload, data);
      if (!payload) { ack?.({ ok: false, error: 'invalid payload' }); return; }
      if (!(await checkViewerRateLimit(userId))) { ack?.({ ok: false, error: 'rate limited' }); return; }
      if (!(await isInContext(userId, payload.context))) { ack?.({ ok: false, error: 'not in context' }); return; }

      const page = await getStreamViewersPage(
        payload.context, payload.streamOwnerId, payload.streamType, payload.page ?? 0,
      );
      ack?.({ ok: true, viewers: page.viewers, nextPage: page.nextPage });
    } catch (err) {
      log.error({ err }, 'viewer:list failed');
      ack?.({ ok: false, error: 'internal error' });
    }
  });
}
