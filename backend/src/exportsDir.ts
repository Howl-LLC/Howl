// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/src/exportsDir.ts
//
// Single source of truth for the GDPR data-export directory. Previously each
// consumer derived this independently: the export/cleanup workers used a
// compiled-module-relative path (which resolves to dist/exports once built),
// while the routes used process.cwd()/exports — so in a built/containerized
// deploy the worker wrote to a directory the download/cleanup paths never
// looked in, and exports silently failed. Resolve it in one place instead.
//
// Override with EXPORTS_DIR (e.g. to point at a mounted volume); otherwise it
// defaults to <cwd>/exports, which is /app/exports in the production image.
import path from 'node:path';

export const EXPORTS_DIR = process.env.EXPORTS_DIR
  ? path.resolve(process.env.EXPORTS_DIR)
  : path.resolve(process.cwd(), 'exports');
