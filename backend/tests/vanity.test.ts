// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Vanity URL tests.
 *
 * Targets endpoints (`backend/src/routes/serverVanity.ts`,
 * `backend/src/utils/vanitySlug.ts`, `backend/src/data/reservedSlugs.ts`)
 * which are not yet merged into this worktree. Written as `it.todo` until
 * those routes land.
 */

import { describe, it } from 'vitest';

describe('Vanity slug format validation', () => {
  it.todo(
    'rejects too short (< 3 chars) with 400',
  );

  it.todo(
    'rejects too long (> 32 chars) with 400',
  );

  it.todo(
    'rejects uppercase letters (slugs are lowercase only)',
  );

  it.todo(
    'rejects characters outside [a-z0-9-]',
  );

  it.todo(
    'rejects double-dashes ("--") anywhere in the slug',
  );

  it.todo(
    'rejects leading or trailing dash',
  );

  it.todo(
    'rejects reserved slugs from denylist (admin, api, help, login, www, etc.)',
  );

  it.todo(
    'rejects slurs / abusive denylist entries',
  );

  it.todo(
    'accepts valid slug "my-server-1"',
  );
});

describe('Vanity claim atomicity', () => {
  it.todo(
    'two concurrent claims for the same slug — exactly one wins, other gets 409',
  );

  it.todo(
    'claiming a new slug atomically releases the previous slug on the same server',
  );

  it.todo(
    'releasing a slug (DELETE) frees it for re-claim',
  );

  it.todo(
    'claim writes AuditLog action=vanity_set',
  );

  it.todo(
    'requires manageServer permission (non-mod → 403)',
  );
});

describe('Public availability check (GET /api/v1/vanity/check)', () => {
  it.todo(
    'returns 200 without auth with { available: boolean }',
  );

  it.todo(
    'never reveals owning server id, name, or owner identity',
  );

  it.todo(
    'rate-limited 60/min per IP — 61st request returns 429',
  );

  it.todo(
    'rejects malformed slug query (400) without leaking that the format check happened',
  );
});
