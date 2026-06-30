// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import cluster from 'node:cluster';
import { cpus } from 'node:os';
import process from 'node:process';
import { logger } from './logger.js';

// Cluster wrapper for the web service. Forks N child processes that each
// run the full server (start.js → server.ts), letting Howl actually use
// the box's cores instead of running a single Node thread on a multi-core
// instance. Cross-process Socket.IO fan-out is already handled by the
// Redis adapter wired up in server.ts:299.
//
// The Worker service (worker.js) is unaffected — it stays single-process.
// BullMQ doesn't need cluster; one worker process consumes the queue
// just fine and avoids duplicate scheduled-job enqueues.
//
// Tuning notes:
//   • Each forked worker opens its own Prisma pool (DB_POOL_MAX). Make
//     sure WEB_CONCURRENCY × DB_POOL_MAX × replicas + worker-service
//     pool stays well under Postgres max_connections.
//     Connection budget: total_connections = WEB_CONCURRENCY × DB_POOL_MAX × replicas + worker_DB_POOL_MAX
//     Worked example: 6 × 20 × 2 + 20 = 260 connections from web tier + worker.
//     Source default DB_POOL_MAX is 10 (see backend/src/db.ts) — protects dev/fresh deploys.
//     Confirm Postgres `max_connections` covers your computed budget before increasing replicas or WEB_CONCURRENCY;
//     beyond ~3 replicas, adding an external pooler (Supavisor / PgBouncer / Prisma Accelerate) is the unlock.
//   • In-process Maps in socketHandlers/infrastructure.ts and several
//     route files (slow-mode, automod, @everyone cooldown) are now
//     per-worker rather than per-replica. These were already best-effort
//     across replicas — clustering doesn't change the
//     correctness story, just the partition count. Redis-backing the
//     abuse-vector ones is tracked as follow-up.

const log = logger.child({ module: 'cluster' });

const requested = parseInt(process.env.WEB_CONCURRENCY || '0', 10);
const concurrency = requested > 0
  ? Math.min(requested, 16)
  : Math.min(Math.max(2, Math.floor(cpus().length / 2)), 8);

if (concurrency <= 1) {
  log.info({ concurrency }, 'WEB_CONCURRENCY<=1 — running single-process (no cluster)');
  await import('./start.js');
} else if (cluster.isPrimary) {
  log.info({
    workers: concurrency,
    cpus: cpus().length,
    pid: process.pid,
  }, 'Cluster primary starting');

  const live = new Set<import('node:cluster').Worker>();
  for (let i = 0; i < concurrency; i++) {
    live.add(cluster.fork());
  }

  cluster.on('exit', (worker, code, signal) => {
    live.delete(worker);
    if (shuttingDown || signal === 'SIGTERM' || signal === 'SIGINT') {
      log.info({ worker: worker.process.pid, signal, code }, 'Worker exited');
      return;
    }
    log.warn({ worker: worker.process.pid, code, signal }, 'Worker exited unexpectedly; respawning');
    live.add(cluster.fork());
  });

  let shuttingDown = false;
  const shutdown = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig, workerCount: live.size }, 'Forwarding shutdown to workers');
    for (const w of live) {
      try { w.process.kill(sig); } catch { /* already gone */ }
    }
    setTimeout(() => {
      log.warn('Force-exiting after 30s grace period');
      process.exit(1);
    }, 30_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} else {
  // Worker process — load the actual server.
  await import('./start.js');
}
