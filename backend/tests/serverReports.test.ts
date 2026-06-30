// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Server-level report tests.
 *
 * Targets endpoints (`backend/src/routes/serverReports.ts`,
 * `backend/src/routes/adminServerReports.ts`) which are not yet merged into
 * this worktree. Written as `it.todo` until those routes land.
 *
 * Scope: server-level abuse reports (reason ∈ spam | harassment | illegal |
 * nsfw_undeclared | impersonation | other). NOT message-level reports — those
 * have their own suite in `reports.test.ts`.
 */

import { describe, it } from 'vitest';

describe('Submit server report (POST /api/v1/servers/:serverId/report)', () => {
  it.todo(
    'requires authentication (anon → 401)',
  );

  it.todo(
    'requires captcha token (NODE_ENV=test auto-bypass)',
  );

  it.todo(
    'rejects unknown reason (400) — must be one of the documented enum',
  );

  it.todo(
    'rejects details > 2000 chars (400)',
  );

  it.todo(
    'creates a pending ServerReport row with status=pending',
  );

  it.todo(
    'duplicate pending report for same (serverId, reporterId) → 409',
  );

  it.todo(
    'rate-limited 5/day per user — 6th submit returns 429',
  );

  it.todo(
    'cannot report your own server (400)',
  );
});

describe('Admin queue (GET /api/v1/admin/server-reports)', () => {
  it.todo(
    'requires admin auth (non-admin → 403, anon → 401)',
  );

  it.todo(
    'paginates by status; ?status=pending returns only pending',
  );

  it.todo(
    'take capped at 100',
  );
});

describe('Admin review (PATCH /api/v1/admin/server-reports/:reportId)', () => {
  it.todo(
    'non-admin → 403',
  );

  it.todo(
    'admin can update status (reviewed | actioned | dismissed) and stores reviewerId + reviewedAt',
  );

  it.todo(
    'updating already-actioned report is allowed (status transitions tracked)',
  );

  it.todo(
    'invalid status enum → 400',
  );
});
