// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// scripts/set-build-date.js
// Wrapper that sets HOWL_BUILD_DATE before spawning electron-builder.
// Called from the `dist` / `dist:mac` / `dist:linux` / `dist:all` npm scripts
// so the main process receives the build date at package time.

import { spawnSync } from 'node:child_process';

process.env.HOWL_BUILD_DATE = new Date().toISOString().slice(0, 10);

const result = spawnSync('npx', ['electron-builder', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

process.exit(result.status ?? 1);
