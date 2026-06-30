// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import './loadEnv.js';
import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { logger } from './logger.js';
import { pub as redisPub, sub as redisSub, redisEnabled } from './redis.js';
import { prisma } from './db.js';
import { setIO } from './socketIO.js';
import { startAllWorkers } from './queues/workers/index.js';
import {
  scheduleRecurringCleanup,
  scheduleServerStatsJobs,
  scheduleSteamActivityPolling,
  scheduleSpotifyActivityPolling,
  scheduleEventReminderPolling,
  scheduleThreadArchivePolling,
  scheduleShowcaseRefreshPolling,
  scheduleTwitchActivityPolling,
  scheduleYouTubeActivityPolling,
  scheduleAnalyticsJobs,
} from './queues/producers.js';
import { setNotificationIO } from './queues/workers/notification.worker.js';
import { setEventReminderIO } from './queues/workers/eventReminder.worker.js';
import { setThreadArchiveIO } from './queues/workers/threadArchive.worker.js';
import { setImportIO } from './queues/workers/import.worker.js';
import { setCalendarIO } from './queues/workers/calendar.worker.js';
import { setCleanupIO } from './queues/workers/cleanup.worker.js';
import { installShutdownHandlers } from './shutdown.js';

installShutdownHandlers();

const log = logger.child({ module: 'worker-entry' });

async function main() {
  log.info('Starting worker process');

  // Headless Socket.IO server — no HTTP listener since workers never accept
  // client WebSocket connections. The Redis adapter is what makes emit()
  // from this process fan out to every WebSocket on the web replicas
  // (server.ts wires the same redisPub/redisSub pair into its own io).
  const io = new SocketServer({
    transports: ['websocket'],
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  if (redisEnabled && redisPub && redisSub) {
    io.adapter(createAdapter(redisPub, redisSub));
    log.info('Redis adapter attached — events fan out to web replicas');
  } else {
    log.error('REDIS_URL not set — worker emits would be black-holed; aborting');
    process.exit(1);
  }

  setIO(io);
  setNotificationIO(io);
  setEventReminderIO(io);
  setThreadArchiveIO(io);
  setImportIO(io);
  setCalendarIO(io);
  setCleanupIO(io);

  const workers = startAllWorkers();

  await Promise.all([
    scheduleRecurringCleanup(),
    scheduleServerStatsJobs(),
    scheduleSteamActivityPolling(),
    scheduleSpotifyActivityPolling(),
    scheduleEventReminderPolling(),
    scheduleThreadArchivePolling(),
    scheduleShowcaseRefreshPolling(),
    scheduleTwitchActivityPolling(),
    scheduleYouTubeActivityPolling(),
    scheduleAnalyticsJobs(),
  ]);

  log.info({ count: workers.length }, 'Workers started');

  // Heartbeat updated on every event-loop tick (5s). If the loop hangs,
  // the staleness shows up in the /health probe — the platform can then restart
  // the container instead of letting it sit silently broken.
  let heartbeat = Date.now();
  setInterval(() => { heartbeat = Date.now(); }, 5000).unref();

  const PORT = parseInt(process.env.PORT || '5000', 10);
  http.createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const checks: Record<string, unknown> = {};
    let healthy = true;

    const eventLoopAgeMs = Date.now() - heartbeat;
    checks.eventLoopAgeMs = eventLoopAgeMs;
    if (eventLoopAgeMs > 30_000) healthy = false;

    try {
      await Promise.race([
        redisPub!.ping(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), 2000)),
      ]);
      checks.redis = 'ok';
    } catch {
      checks.redis = 'fail';
      healthy = false;
    }

    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, rej) => setTimeout(() => rej(new Error('db ping timeout')), 2000)),
      ]);
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
      healthy = false;
    }

    const closed = workers.filter((w) => (w as unknown as { closing?: unknown }).closing).length;
    const running = workers.length - closed;
    checks.workers = { running, total: workers.length };
    if (workers.length > 0 && running === 0) healthy = false;

    res.statusCode = healthy ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks }));
  }).listen(PORT, () => {
    log.info({ port: PORT }, 'Health server listening');
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Worker startup failed');
  process.exit(1);
});
