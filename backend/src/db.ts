// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import fs from 'fs';
import path from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma-client-v7/client.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'db' });

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Set it in the environment.');
}

function parseDbUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      database: parsed.pathname.replace(/^\//, ''),
    };
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const { user, password, host, port, database } = parseDbUrl(connectionString);

// `DB_SSL=false` disables TLS on the backend↔DB hop. Used when the runtime
// connection target is a connection pooler (PgBouncer) reachable only over
// the platform's private internal network — the pooler→PG hop still uses TLS via
// the pooler's own server-side config.
const useSsl = process.env.DB_SSL === 'false' ? false : isProduction;

log.info({ host, port, database, ssl: useSsl }, 'connecting');

// Each cluster worker opens its own pg pool — see backend/src/cluster.ts for the
// full connection-budget formula. Production sets DB_POOL_MAX explicitly via env
// (currently 20). The conservative 10 default protects dev / fresh deploys where
// the env var isn't set, so a 6-worker cluster doesn't claim 300 PG connections
// out of the box.
const poolMax = Math.max(1, parseInt(process.env.DB_POOL_MAX || '10', 10) || 10);
const poolMin = Math.max(0, parseInt(process.env.DB_POOL_MIN || '2', 10) || 2);

const pool = new pg.Pool({
  user,
  password,
  host,
  port,
  database,
  ssl: useSsl ? {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted env var
    ...(process.env.RDS_CA_PATH ? { ca: fs.readFileSync(path.resolve(process.env.RDS_CA_PATH), 'utf8') } : {}),
  } : undefined,
  max: poolMax,
  min: poolMin,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});

const adapter = new PrismaPg(pool);

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

// Encryption downgrade guard
// Once a DMChannel is created with encrypted=true (the default), it must
// never be flipped to false. This server-side invariant prevents a
// compromised admin session or rogue migration from downgrading encryption.
// Covers every write verb Prisma exposes: update, updateMany, upsert,
// createMany, and create. `create` is defensive — no current caller passes
// `encrypted: false`, but a future caller would fail loud rather than silently
// persist a downgraded channel.
const DOWNGRADE_ERROR =
  'Encryption downgrade is not allowed: DMChannel.encrypted cannot be set to false';

function assertNoEncryptionDowngrade(payload: unknown): void {
  if (payload && typeof payload === 'object' && 'encrypted' in payload && (payload as Record<string, unknown>).encrypted === false) {
    throw new Error(DOWNGRADE_ERROR);
  }
}

export const prisma = basePrisma.$extends({
  query: {
    dMChannel: {
      async update({ args, query }) {
        assertNoEncryptionDowngrade(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertNoEncryptionDowngrade(args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        assertNoEncryptionDowngrade(args.update);
        assertNoEncryptionDowngrade(args.create);
        return query(args);
      },
      async createMany({ args, query }) {
        const rows = Array.isArray(args.data) ? args.data : [args.data];
        for (const r of rows) assertNoEncryptionDowngrade(r);
        return query(args);
      },
      async create({ args, query }) {
        assertNoEncryptionDowngrade(args.data);
        return query(args);
      },
    },
  },
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma;
