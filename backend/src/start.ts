// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Production entry point.
 * Resolves DATABASE_URL then starts the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import './loadEnv.js';
import './instrument.js'; // Sentry must init before anything else
import { installShutdownHandlers } from './shutdown.js';
import { ensureDatabaseUrl } from './getDatabaseUrl.js';
import { logger } from './logger.js';

installShutdownHandlers();

const log = logger.child({ module: 'start' });

function ensureDeployArtifacts() {
  const cwd = process.cwd();
  const checks = [
    path.join(cwd, 'dist', 'src', 'db.js'),
    path.join(cwd, 'dist', 'generated', 'prisma-client-v7', 'internal', 'class.js'),
  ];
  for (const file of checks) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(file)) {
      const dir = path.dirname(file);
      const parent = path.dirname(dir);
      log.error({ file }, 'missing required file');
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (fs.existsSync(parent)) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          log.error({ dir: parent, contents: fs.readdirSync(parent) }, 'parent directory listing');
        }
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (fs.existsSync(dir)) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          log.error({ dir, contents: fs.readdirSync(dir) }, 'directory listing');
        }
      } catch (e) {
        log.error({ err: e }, 'could not list dirs');
      }
      log.error('rebuild with: cd backend && npx prisma generate && npm run build');
      process.exit(1);
    }
  }
}

async function main() {
  log.info({ nodeEnv: process.env.NODE_ENV, port: process.env.PORT }, 'starting');

  ensureDeployArtifacts();
  log.info('deploy artifacts OK');

  try {
    await ensureDatabaseUrl();
    log.info({ urlLength: (process.env.DATABASE_URL ?? '').length }, 'DATABASE_URL resolved');
  } catch (err) {
    log.error({ err }, 'failed to set DATABASE_URL');
    process.exit(1);
  }

  // TCP connectivity check to database before loading server
  try {
    const dbUrl = process.env.DATABASE_URL ?? '';
    const parsedUrl = (() => { try { return new URL(dbUrl); } catch { return null; } })();
    if (parsedUrl) {
      const host = parsedUrl.hostname;
      const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 5432;
      log.info({ host, port }, 'TCP check starting');
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host, port, timeout: 5000 }, () => {
          log.info('TCP check OK');
          sock.destroy();
          resolve();
        });
        sock.on('error', (err) => {
          log.error({ err }, 'TCP check FAILED');
          sock.destroy();
          reject(err);
        });
        sock.on('timeout', () => {
          log.error('TCP check TIMEOUT after 5s');
          sock.destroy();
          reject(new Error('TCP timeout'));
        });
      });
    }
  } catch (tcpErr) {
    log.fatal({ err: tcpErr }, 'cannot reach database host — check DATABASE_URL and network configuration');
    process.exit(1);
  }

  log.info('loading server...');
  await import('./server.js');

  // Clean up ghost voice participants and start periodic health check
  setTimeout(async () => {
    try {
      const { cleanupStaleVoiceParticipants, startVoiceHealthCheck } = await import('./socketHandlers/infrastructure.js');
      await cleanupStaleVoiceParticipants();
      startVoiceHealthCheck();
    } catch (err) {
      log.error({ err }, 'startup voice cleanup failed');
    }
  }, 5000);
}

main().catch((err) => {
  log.error({ err }, 'startup error');
  process.exit(1);
});
