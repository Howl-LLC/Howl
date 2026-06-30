// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/**
 * Electron release pre-flight check.
 *
 * Previously this script also ran `vite build` with VITE_* env vars injected
 * so the frontend dist/ bundle could be shipped inside the installer. That's
 * no longer the model: packaged Electron loads the renderer directly from
 * https://app.howlpro.com (Cloudflare Pages), and electron-builder's `files`
 * array no longer includes dist/. The CDN's own Pages build supplies the
 * VITE_* values — baking them here produced a bundle nothing ever loaded.
 *
 * What the main process (main.js) still needs at runtime is
 * `release-config.json`, shipped inside the asar. Its contents are public by
 * design (backend origin, CF Access team URL, Sentry DSN — the latter is
 * meant to be embedded in client code per Sentry docs). This script just
 * validates that file so CI fails loudly if a required key is missing,
 * rather than letting Electron fall back to `https://app.howlpro.com`
 * defaults and hiding the misconfiguration.
 *
 * NEVER put these in release-config.json — they stay on the backend server
 * env only: *_SECRET, LIVEKIT_API_SECRET, STRIPE_SECRET_KEY,
 * STRIPE_WEBHOOK_SECRET, DATABASE_URL, OAuth client secrets, KLIPY_API_KEY,
 * R2/S3 access keys, MFA_ENCRYPTION_KEY.
 */

const REQUIRED_KEYS = ['BACKEND_URL', 'FRONTEND_ORIGIN'];
const OPTIONAL_KEYS = ['SENTRY_DSN', 'CLOUDFLARE_ACCESS_TEAM_URL'];

const cfg = join(root, 'release-config.json');
const cfgExample = join(root, 'release-config.example.json');

if (!existsSync(cfg) && !existsSync(cfgExample)) {
  console.error('ERROR: neither release-config.json nor release-config.example.json found.');
  console.error('Create release-config.json based on release-config.example.json (see that file for required shape).');
  process.exit(1);
}

const path = existsSync(cfg) ? cfg : cfgExample;
let parsed;
try {
  parsed = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`ERROR: ${path} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const missing = REQUIRED_KEYS.filter((k) => !parsed[k]);
if (missing.length) {
  console.error(`ERROR: ${path} is missing required keys: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Electron release pre-flight:');
console.log(`  Config file:   ${existsSync(cfg) ? 'release-config.json' : 'release-config.example.json (fallback)'}`);
for (const k of REQUIRED_KEYS) console.log(`  ${k}: ${parsed[k]}`);
for (const k of OPTIONAL_KEYS) console.log(`  ${k}: ${parsed[k] || '(empty)'}`);
console.log('Pre-flight passed. Run `npm run dist` (or the OS-specific variant) to package.');
