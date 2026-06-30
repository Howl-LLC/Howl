// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Graceful shutdown handler.
 *
 * On SIGTERM / SIGINT:
 * 1. Stop accepting new HTTP connections
 * 2. Close Socket.IO (disconnects all WebSocket clients cleanly)
 * 3. Close BullMQ workers (let in-progress jobs finish)
 * 4. Close BullMQ queues
 * 5. Disconnect Redis clients
 * 6. Disconnect Prisma
 * 7. Flush Sentry events
 * 8. Force exit after a timeout if something hangs
 */

import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import { logger } from './logger.js';
import { Sentry, sentryEnabled } from './instrument.js';
import { prisma } from './db.js';

const log = logger.child({ module: 'shutdown' });

const SHUTDOWN_TIMEOUT_MS = 15_000;

export let isShuttingDown = false;

export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

interface ShutdownDeps {
  httpServer: http.Server;
  io: SocketServer;
  workers: Worker[];
  queues: Queue[];
  redisClients: (Redis | null)[];
}

let deps: ShutdownDeps | null = null;

export function registerShutdownDeps(d: ShutdownDeps): void {
  deps = d;
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info({ signal }, 'graceful shutdown initiated');

  const forceTimer = setTimeout(() => {
    log.error('shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    if (!deps) {
      log.warn('no shutdown deps registered');
      process.exit(0);
    }

    // 1. Stop HTTP server (stop accepting new connections, finish in-flight)
    await new Promise<void>((resolve) => {
      deps!.httpServer.close(() => {
        log.info('HTTP server closed');
        resolve();
      });
      deps!.httpServer.closeIdleConnections();
      setTimeout(resolve, 5000);
    });

    // 2. Close Socket.IO
    await new Promise<void>((resolve) => {
      deps!.io.close(() => {
        log.info('Socket.IO closed');
        resolve();
      });
      setTimeout(resolve, 3000);
    });

    // 3. Close BullMQ workers (waits for current jobs to finish)
    if (deps.workers.length > 0) {
      await Promise.allSettled(deps.workers.map((w) => w.close()));
      log.info({ count: deps.workers.length }, 'BullMQ workers closed');
    }

    // 4. Close BullMQ queues
    if (deps.queues.length > 0) {
      await Promise.allSettled(deps.queues.map((q) => q.close()));
      log.info({ count: deps.queues.length }, 'BullMQ queues closed');
    }

    // 5. Disconnect Redis
    const activeRedis = deps.redisClients.filter(Boolean) as Redis[];
    if (activeRedis.length > 0) {
      await Promise.allSettled(activeRedis.map((c) => c.quit()));
      log.info({ count: activeRedis.length }, 'Redis clients disconnected');
    }

    // 6. Disconnect Prisma
    await prisma.$disconnect();
    log.info('Prisma disconnected');

    // 7. Flush Sentry
    if (sentryEnabled) {
      await Sentry.flush(2000);
      log.info('Sentry flushed');
    }

    log.info('shutdown complete');
  } catch (err) {
    log.error({ err }, 'error during shutdown');
  } finally {
    clearTimeout(forceTimer);
    process.exit(0);
  }
}

export function installShutdownHandlers(): void {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    if (sentryEnabled) {
      Sentry.captureException(err);
    }
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection');
    if (sentryEnabled) {
      Sentry.captureException(reason);
    }
  });

  log.info('shutdown handlers installed');
}
