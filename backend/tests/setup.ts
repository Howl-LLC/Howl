// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Global test setup — runs once before all test suites.
 * Loads .env so DATABASE_URL and other vars are available,
 * then overrides test-specific values.
 */

import path from 'path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

process.env.NODE_ENV = 'test';
// Opt into the deterministic SHA-256 escrow fallback for the test harness. In any
// deployed env this flag is unset, so escrow fails closed.
process.env.ALLOW_TEST_ESCROW_KEY = '1';
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-for-vitest';
process.env.LOG_LEVEL = 'silent';

// ts-mls's default crypto provider needs globalThis.crypto.subtle. Node 20+
// exposes it natively (this env is Node 25), so this is a GUARDED no-op shim:
// it only installs webcrypto when no global crypto exists, and must NOT
// overwrite the (more complete) native implementation when present.
if (typeof globalThis.crypto === 'undefined') {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

// Disable CAPTCHA verification in tests (no real Turnstile token available).
// Set to empty string rather than deleting so that dotenv won't re-populate
// it from .env (dotenv skips vars that already exist in process.env).
process.env.TURNSTILE_SECRET_KEY = '';
