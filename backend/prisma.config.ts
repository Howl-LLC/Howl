// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // DDL (migrate/seed) MUST use a direct PG URL — DDL through a transaction-mode
    // pooler isn't safe, and even in session mode some DDL operations (e.g. CREATE
    // INDEX CONCURRENTLY) require a direct connection. Prefer DIRECT_URL when set;
    // fall back to DATABASE_URL for environments without a pooler in front.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? 'postgresql://localhost:5432/howl',
  },
});
