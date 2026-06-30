// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Server stats rollup worker for public/community servers.
 *
 * Computes one DailyServerStats row per community-enabled server per UTC
 * day. Triggered by a daily BullMQ repeat job at 00:30 UTC; the `daily`
 * variant always targets *yesterday* in UTC. The `backfill` variant is
 * for re-running a missed day with an explicit `YYYY-MM-DD`.
 *
 * Reads (no DM tables — DMs are E2E and explicitly excluded):
 *   - ServerMember (joins, current member count, retainedAfter7d)
 *   - Channel (per-server channelIds for message-count scoping)
 *   - Message (channel-scoped count between [start, end))
 *   - StageSession (best-effort voice/stage minutes)
 *
 * Discovery opt-out: when the `User.discoveryOptOut` field is added, the
 * joins/retainedAfter7d filters here should be amended to exclude opt-out
 * users from the public-ranking signals. The owner-facing per-server
 * insights stay inclusive (an owner needs an honest view of their own
 * community's growth).
 *
 * Batching: at most 1000 servers per Prisma fetch, processed sequentially
 * inside the batch with a per-server upsert. We rely on the DB unique
 * constraint (serverId, date) for idempotency — running the worker twice
 * on the same day is safe.
 *
 * DM E2E sanctity (CRITICAL): this worker MUST NOT touch `DMChannel`,
 * `DMMessage`, `DmKeyBundle`, or any other E2E-DM-adjacent model.
 * See docs/howl-dm-encryption-spec.md.
 */

import { Worker, Job } from 'bullmq';
import { Prisma } from '../../../generated/prisma-client-v7/client.js';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { serverStatsJobSchema } from '../workerSchemas.js';

const log = logger.child({ module: 'worker:server-stats' });

const SERVER_BATCH_SIZE = 1000;
// Hard upper bound on the cursor-pagination loop — 1M servers ÷ 1k batch =
// 1000 ticks. We pick 2000 as a generous safety margin so a runaway cursor
// can't loop forever if the underlying query starts misbehaving.
const MAX_BATCHES = 2000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Per-server stage-session fetch cap — a server with more than this in a
// single day is in pathological territory; we'd rather under-count voice
// minutes than load an unbounded set into memory.
const STAGE_SESSION_FETCH_CAP = 5000;

/**
 * Resolve the [start, end) UTC window for a `YYYY-MM-DD` date string. The
 * `date` column on DailyServerStats is `@db.Date`, so we anchor everything
 * to UTC midnight to avoid timezone drift between worker host and DB.
 */
function utcDayWindow(dateStr: string): { start: Date; end: Date; date: Date } {
  // Construct as UTC midnight; appending the literal "T00:00:00.000Z" makes
  // the resulting Date timezone-stable regardless of process TZ.
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`invalid date: ${dateStr}`);
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, date: start };
}

/** Yesterday's UTC date as `YYYY-MM-DD`. */
function yesterdayUtcDateString(): string {
  const now = new Date();
  const yesterdayUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  ));
  return yesterdayUtc.toISOString().slice(0, 10);
}

interface ComputedStats {
  members: number;
  joins: number;
  leaves: number;
  messages: number;
  voiceMinutes: number;
  retainedAfter7d: number;
}

/**
 * Compute stats for a single server within a UTC day window.
 *
 * Each metric is a bounded count or aggregate; no metric loads a list of
 * rows into memory beyond the per-window stage-session set (capped via
 * `take`).
 */
async function computeServerStats(
  serverId: string,
  start: Date,
  end: Date,
): Promise<ComputedStats> {
  // Members: current ServerMember count (snapshotted at compute time).
  const members = await prisma.serverMember.count({ where: { serverId } });

  // Joins: ServerMember rows whose joinedAt falls inside the window.
  //   When User.discoveryOptOut lands, this query should additionally
  //   filter `user: { discoveryOptOut: false }` so opt-out users don't
  //   feed public ranking signals.
  const joins = await prisma.serverMember.count({
    where: {
      serverId,
      joinedAt: { gte: start, lt: end },
    },
  });

  // Leaves: ServerMember rows are deleted on leave/kick/ban (no
  //   `leftAt` column). Best-effort = 0; a future migration could back
  //   this with AuditLog scans for `member_kick` / `member_ban` /
  //   `member_leave` action rows.
  const leaves = 0;

  // Messages: server channel messages only — DM messages are E2E and
  //   never counted. Filtering by `channel.serverId` keeps the query
  //   scoped to the server's own channels even if a channel is later
  //   moved or renamed.
  const messages = await prisma.message.count({
    where: {
      createdAt: { gte: start, lt: end },
      channel: { serverId },
    },
  });

  // Voice minutes: aggregate StageSession durations that overlap the
  //   window. `endedAt` is null for sessions still in progress at compute
  //   time; we conservatively cap them at the window end so a runaway
  //   session can't inflate yesterday's row.
  const sessions = await prisma.stageSession.findMany({
    where: {
      serverId,
      startedAt: { lt: end },
      OR: [
        { endedAt: null },
        { endedAt: { gte: start } },
      ],
    },
    select: { startedAt: true, endedAt: true },
    take: STAGE_SESSION_FETCH_CAP,
  });
  let voiceMs = 0;
  for (const s of sessions) {
    const sessionStart = s.startedAt.getTime();
    const sessionEnd = s.endedAt ? s.endedAt.getTime() : end.getTime();
    const overlapStart = Math.max(sessionStart, start.getTime());
    const overlapEnd = Math.min(sessionEnd, end.getTime());
    if (overlapEnd > overlapStart) voiceMs += overlapEnd - overlapStart;
  }
  const voiceMinutes = Math.floor(voiceMs / 60_000);

  // retainedAfter7d: members who joined ≥7 days ago AND are still in
  //   the server. Same opt-out caveat as `joins` — patch in the
  //   discoveryOptOut filter once that column exists.
  const sevenDaysAgo = new Date(end.getTime() - SEVEN_DAYS_MS);
  const retainedAfter7d = await prisma.serverMember.count({
    where: {
      serverId,
      joinedAt: { lt: sevenDaysAgo },
    },
  });

  return { members, joins, leaves, messages, voiceMinutes, retainedAfter7d };
}

/**
 * Process one batch of community-enabled servers. Returns the cursor for
 * the next batch (or null when done) and the count of servers handled.
 */
async function processBatch(
  start: Date,
  end: Date,
  date: Date,
  cursor: string | null,
): Promise<{ count: number; nextCursor: string | null }> {
  // Build args imperatively so `skip: 1` + `cursor` only apply on the
  // second-and-later iteration. On the first call (cursor === null) Prisma
  // sees no cursor and starts at offset 0; on subsequent calls we skip the
  // cursor row itself to avoid double-processing the boundary server.
  const args: Prisma.ServerFindManyArgs = {
    where: {
      settings: { communityEnabled: true },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: SERVER_BATCH_SIZE,
  };
  if (cursor) {
    args.skip = 1;
    args.cursor = { id: cursor };
  }
  const servers = await prisma.server.findMany(args);

  for (const server of servers) {
    try {
      const stats = await computeServerStats(server.id, start, end);
      await prisma.dailyServerStats.upsert({
        where: { serverId_date: { serverId: server.id, date } },
        create: { serverId: server.id, date, ...stats },
        update: { ...stats, computedAt: new Date() },
      });
      log.info({ serverId: server.id, date: date.toISOString().slice(0, 10), computed: stats }, 'daily server stats computed');
    } catch (err) {
      // One server failing shouldn't poison the whole batch; log and move
      // on. The next day's run will overwrite a partial row via upsert.
      log.error({ err, serverId: server.id }, 'failed to compute server stats');
    }
  }

  const nextCursor = servers.length === SERVER_BATCH_SIZE ? servers[servers.length - 1].id : null;
  return { count: servers.length, nextCursor };
}

export async function runServerStatsForDate(dateStr: string): Promise<{ totalServers: number; date: string }> {
  const { start, end, date } = utcDayWindow(dateStr);
  let cursor: string | null = null;
  let totalServers = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { count, nextCursor }: { count: number; nextCursor: string | null } = await processBatch(start, end, date, cursor);
    totalServers += count;
    if (nextCursor === null) break;
    cursor = nextCursor;
  }
  log.info({ date: dateStr, totalServers }, 'server stats rollup complete');
  return { totalServers, date: dateStr };
}

async function processJob(job: Job): Promise<void> {
  const parsed = serverStatsJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid server-stats job payload');
    return;
  }

  const dateStr = parsed.data.type === 'backfill'
    ? parsed.data.date
    : yesterdayUtcDateString();

  await runServerStatsForDate(dateStr);
}

export function startServerStatsWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('server-stats', processJob, {
    connection: redisConnection,
    concurrency: 1,
    // Rollup can take a while on a large fleet; 30 min covers ~1k servers
    // at ~1.5s each plus headroom for DB contention.
    lockDuration: 30 * 60 * 1000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: server-stats job permanently failed after all retries');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'server-stats job failed (will retry)');
    }
  });

  log.info('server-stats worker started');
  return worker;
}
