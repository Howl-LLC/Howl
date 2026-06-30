// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Apply-to-join tests.
 *
 * Targets endpoints in `backend/src/routes/serverApplications.ts` which are
 * not yet merged into this worktree. Written as `it.todo` until they land.
 *
 * The captcha service (`backend/src/services/captcha.ts`) auto-bypasses in
 * NODE_ENV=test, so the real test bodies don't need to mint Turnstile tokens —
 * they just send `{ captchaToken: '' }` (or omit it) and the handler treats
 * verifyCaptcha() as success when TURNSTILE_SECRET_KEY is empty in test env.
 */

import { describe, it } from 'vitest';

describe('Application questions (PATCH .../applications/questions)', () => {
  it.todo(
    'rejects > 5 questions with 400',
  );

  it.todo(
    'rejects question prompt > 200 chars',
  );

  it.todo(
    'rejects unknown question type (must be short | long | choice)',
  );

  it.todo(
    'rejects maxLength > 2000',
  );

  it.todo(
    'requires manageMembers permission (non-mod → 403)',
  );

  it.todo(
    'persists questions and returns them on subsequent GET',
  );
});

describe('Submit application (POST .../applications)', () => {
  it.todo(
    'requires authentication (anon → 401)',
  );

  it.todo(
    'requires captcha token (or NODE_ENV=test bypass) — invalid token → 400',
  );

  it.todo(
    'creates a pending ServerApplication on first submit',
  );

  it.todo(
    'duplicate pending submission for same (serverId, userId) → 409 conflict',
  );

  it.todo(
    'rate-limited 3/day per user — 4th submit → 429',
  );

  it.todo(
    'returns 400 if joinMethod is not "apply_to_join"',
  );

  it.todo(
    'banned users cannot submit (403 forbidden)',
  );

  it.todo(
    'validates answers against configured questions (missing required answer → 400)',
  );
});

describe('Owner review (PATCH .../applications/:appId)', () => {
  it.todo(
    'requires manageMembers permission (non-mod → 403)',
  );

  it.todo(
    'accept creates a ServerMember row for the applicant',
  );

  it.todo(
    'accept writes AuditLog action=application_decided with detail status=accepted',
  );

  it.todo(
    'reject does NOT create ServerMember; sends notification only',
  );

  it.todo(
    'reject writes AuditLog action=application_decided with detail status=rejected',
  );

  it.todo(
    'reject with optional decisionNote stores the note',
  );

  it.todo(
    'cannot accept an already-accepted application (409)',
  );
});

describe('Withdraw application (DELETE .../applications/me)', () => {
  it.todo(
    'sets the applicant\'s pending application to status=withdrawn',
  );

  it.todo(
    'idempotent: withdrawing without a pending application → 404',
  );

  it.todo(
    'after withdraw, applicant may resubmit (no 409)',
  );
});
