// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery directory tests.
 *
 * Targets the endpoints in `backend/src/routes/discover.ts` and
 * `backend/src/routes/publicDiscover.ts`, which are not yet merged into this
 * worktree. Written as `it.todo` until those routes land.
 *
 * Spoiler-rename / age-gate model:
 *   - `Server.nsfwLevel` and `User.explicitContentFilter` have been dropped.
 *   - Discovery now uses `Channel.ageRestricted` as the exclusion mechanism:
 *     servers with any age-restricted channel cannot be listed in Discovery
 *     (enforced via mutual exclusion at PATCH time, not at query time).
 *   - DM tables (DMChannel, DMMessage) MUST NOT be queried by these handlers.
 *
 * Critical invariants the real tests must enforce when flipped from todo:
 *   - Suspended servers (Server.suspendedAt IS NOT NULL) are NEVER returned.
 *   - hiddenFromDiscovery servers are NEVER returned.
 *   - communityEnabled && discoveryEnabled is required for inclusion.
 *   - Anonymous endpoints never include member lists or channel lists.
 *   - Servers with any age-restricted channel are excluded via the
 *     discovery x age-restriction mutual exclusion (they can't have
 *     discoveryEnabled=true if any channel has ageRestricted=true).
 */

import { describe, it } from 'vitest';

describe('Authenticated discovery (GET /api/v1/discover)', () => {
  it.todo(
    'requires auth or returns 401',
  );

  it.todo(
    'returns paginated cursor results with consistent ordering across pages',
  );

  it.todo(
    'pagination cursor is stable: page 2 contains servers strictly after page 1',
  );

  it.todo(
    'never returns suspended servers (Server.suspendedAt IS NOT NULL)',
  );

  it.todo(
    'never returns hiddenFromDiscovery servers',
  );

  it.todo(
    'never returns servers without communityEnabled && discoveryEnabled',
  );

  it.todo(
    'servers with age-restricted channels cannot have discoveryEnabled=true (mutual exclusion enforced at PATCH time)',
  );

  it.todo(
    'category filter returns only servers in that category',
  );

  it.todo(
    'tag filter (repeatable, max 5) returns servers with at least one matching tag',
  );

  it.todo(
    'q full-text search ranks by relevance against name + longDescription + tags',
  );

  it.todo(
    'sort=members orders by descending member count',
  );

  it.todo(
    'sort=new orders by descending discoverableSince',
  );

  it.todo(
    'page size capped at 24 -- requesting more is silently clamped',
  );
});

describe('Public anonymous discovery (GET /api/v1/public/discover)', () => {
  it.todo(
    'returns 200 without auth',
  );

  it.todo(
    'servers with age-restricted channels are excluded by mutual exclusion (discoveryEnabled cannot be true)',
  );

  it.todo(
    'never includes member lists or channel lists in response objects',
  );

  it.todo(
    'returns only public-safe fields: id, vanityUrl, name, icon, banner, longDescription, category, tags, language, memberCount, online, verified, featured',
  );

  it.todo(
    'IP rate-limited at 60/min -- 61st request from same IP returns 429',
  );

  it.todo(
    'never returns suspended or hiddenFromDiscovery servers',
  );
});

describe('Discovery -- DM E2E sanctity', () => {
  it.todo(
    'discovery handlers never read DMMessage or DMChannel rows (verify via Prisma query log)',
  );
});
