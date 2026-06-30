// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Production entry point.
 * Resolves DATABASE_URL then starts the server.
 */
import { logger } from './logger.js';

const log = logger.child({ module: 'getDatabaseUrl' });

export async function ensureDatabaseUrl(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log.fatal('DATABASE_URL is not set. Set it in your environment variables.');
    process.exit(1);
  }
}
