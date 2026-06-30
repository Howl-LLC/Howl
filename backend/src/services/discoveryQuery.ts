// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared discovery query runner.
 *
 * Both `routes/discover.ts` (authenticated) and `routes/publicDiscover.ts`
 * (anonymous) call into `runDiscoveryQuery`. The two routes only differ in
 * (a) what's stripped from the response card and (b) cache headers; the
 * underlying database query and ranking is identical.
 *
 * Implementation notes:
 *  - Tags are stored on `ServerSettings.tags` as a JSON `string[]`. Postgres
 *    JSONB containment (`@>`) is used to filter by tag without requiring
 *    extra columns. The query uses parameterised `Prisma.sql` so no user
 *    input is interpolated raw.
 *  - Search uses `ILIKE` against name + longDescription + JSON-stringified
 *    tags. The schema doesn't (yet) have an FTS column on Server, so
 *    `plainto_tsquery` isn't available here — `ILIKE` with `escapeLikePattern`
 *    is the documented fallback.
 *  - Ranking by "active" is best-effort: the existing schema has no message-
 *    count cache; we approximate via member count for now and document the
 *    limitation. A future BullMQ worker can populate a column without
 *    changing the API surface.
 *  - The query fetches `pageSize + 1` rows so we can produce a `nextCursor`
 *    without a separate `count(*)` round-trip.
 */

import { prisma } from '../db.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import {
  DISCOVERY_QUERY_MAX_LENGTH,
  decodeCursor,
  encodeCursor,
  escapeLikePattern,
  type DiscoverySort,
} from '../utils/discoveryFilters.js';

export interface DiscoveryQueryInput {
  q?: string;
  category?: string;
  tags?: string[];
  language?: string;
  sort: DiscoverySort;
  cursor?: string;
  pageSize: number;
  /** When true, restrict to `Server.featured = true` (used by /featured). */
  featuredOnly?: boolean;
}

export interface DiscoveryQueryRow {
  id: string;
  vanityUrl: string | null;
  name: string;
  icon: string | null;
  banner: string | null;
  bannerSplash: string | null;
  longDescription: string | null;
  category: string | null;
  subcategory: string | null;
  tags: unknown;
  language: string | null;
  verified: boolean;
  featured: boolean;
  memberCount: number;
  online: number;
  discoverableSince: Date | null;
  createdAt: Date;
}

export interface DiscoveryQueryResult {
  rows: DiscoveryQueryRow[];
  nextCursor: string | null;
}

export interface DiscoveryServerCard {
  id: string;
  vanityUrl: string | null;
  name: string;
  icon: string | null;
  banner: string | null;
  bannerSplash: string | null;
  /** Marketing description. Field name matches the frontend ServerCardSummary
   * shape (`description`, not `longDescription`). */
  description: string | null;
  category: string | null;
  subcategory?: string | null;
  tags: string[];
  language: string | null;
  memberCount?: number;
  /** Online members. Field name matches the frontend ServerCardSummary
   * shape (`onlineCount`, not `online`). */
  onlineCount?: number;
  verified: boolean;
  featured: boolean;
}

// Result mapper

export interface MapCardOptions {
  includeMemberCount: boolean;
  includeOnline: boolean;
  /** Public surface drops subcategory to keep the card minimal. */
  publicMinimal?: boolean;
}

export function mapServerRowToCard(row: DiscoveryQueryRow, opts: MapCardOptions): DiscoveryServerCard {
  // Tags column is `Json?` — coerce defensively.
  const tags: string[] = Array.isArray(row.tags)
    ? (row.tags.filter((t) => typeof t === 'string') as string[])
    : [];

  const card: DiscoveryServerCard = {
    id: row.id,
    vanityUrl: row.vanityUrl ?? null,
    name: row.name,
    icon: row.icon ?? null,
    banner: row.banner ?? null,
    bannerSplash: row.bannerSplash ?? null,
    description: row.longDescription ?? null,
    category: row.category ?? null,
    tags,
    language: row.language ?? null,
    verified: !!row.verified,
    featured: !!row.featured,
  };
  if (!opts.publicMinimal) card.subcategory = row.subcategory ?? null;
  if (opts.includeMemberCount) card.memberCount = row.memberCount;
  if (opts.includeOnline) card.onlineCount = row.online;
  return card;
}

// Cursor sort-value extraction

function rowSortValue(row: DiscoveryQueryRow, sort: DiscoverySort): string {
  if (sort === 'new') {
    return (row.discoverableSince ?? row.createdAt).toISOString();
  }
  if (sort === 'members' || sort === 'active') {
    // 0-pad so lexical comparison matches numeric ordering inside the cursor.
    return String(row.memberCount).padStart(12, '0');
  }
  // relevance — no rank exposed; cursor pivots on memberCount as the stable secondary key.
  return String(row.memberCount).padStart(12, '0');
}

// Main query

export async function runDiscoveryQuery(input: DiscoveryQueryInput): Promise<DiscoveryQueryResult> {
  const limit = Math.max(1, Math.min(input.pageSize, 24));
  const fetchLimit = limit + 1;

  // Build WHERE conditions.
  // Eligibility gate: only listed if the cached `eligibleForDiscoverySince`
  // is set (server passes size/age/activity bars) OR the server is verified
  // (admin-granted blue badge — verified orgs grandfather in regardless of
  // size). The cached column is on the already-JOINed `ServerSettings` row,
  // so the filter adds zero new query cost.
  const where: Prisma.Sql[] = [
    Prisma.sql`ss."communityEnabled" = true`,
    Prisma.sql`ss."discoveryEnabled" = true`,
    Prisma.sql`s."hiddenFromDiscovery" = false`,
    Prisma.sql`s."suspendedAt" IS NULL`,
    Prisma.sql`(ss."eligibleForDiscoverySince" IS NOT NULL OR s."verified" = true)`,
  ];

  if (input.featuredOnly) {
    where.push(Prisma.sql`s."featured" = true`);
  }

  if (input.category) {
    where.push(Prisma.sql`ss."category" = ${input.category}`);
  }

  if (input.language) {
    where.push(Prisma.sql`ss."language" = ${input.language}`);
  }

  if (input.tags && input.tags.length > 0) {
    // Use JSONB containment — `tags @> '["foo","bar"]'::jsonb` requires every
    // requested tag to be present. Cast through text for parameter safety.
    const tagsJson = JSON.stringify(input.tags);
    where.push(Prisma.sql`ss."tags"::jsonb @> ${tagsJson}::jsonb`);
  }

  if (input.q) {
    const safeQ = input.q.slice(0, DISCOVERY_QUERY_MAX_LENGTH).trim();
    if (safeQ) {
      const escaped = escapeLikePattern(safeQ);
      const pattern = `%${escaped}%`;
      where.push(
        Prisma.sql`(
          s."name" ILIKE ${pattern}
          OR ss."longDescription" ILIKE ${pattern}
          OR (ss."tags" IS NOT NULL AND ss."tags"::text ILIKE ${pattern})
        )`,
      );
    }
  }

  // The member-count subquery is reused as a SELECT column AND as a
  // cursor/ORDER-BY pivot. Postgres can't reference SELECT aliases inside
  // WHERE, so the expression lives in a fragment we splice into both spots —
  // the planner materialises the count once and reuses it via the
  // ServerMember.serverId index.
  const memberCountExpr = Prisma.sql`(SELECT COUNT(*)::int FROM "ServerMember" sm WHERE sm."serverId" = s."id")`;
  const onlineCountExpr = Prisma.sql`(
    SELECT COUNT(*)::int FROM "ServerMember" sm
      JOIN "User" u ON u."id" = sm."userId"
     WHERE sm."serverId" = s."id" AND u."status" <> 'offline'
  )`;

  // Cursor — apply only when given; format depends on sort.
  const decoded = decodeCursor(input.cursor);
  if (decoded) {
    if (input.sort === 'new') {
      // Older `discoverableSince` (or createdAt fallback) than cursor's value,
      // tie-break by id to make the page boundary deterministic.
      const cursorDate = new Date(decoded.sortValue);
      if (!isNaN(cursorDate.getTime())) {
        where.push(Prisma.sql`(
          (COALESCE(ss."discoverableSince", s."createdAt") < ${cursorDate})
          OR (COALESCE(ss."discoverableSince", s."createdAt") = ${cursorDate} AND s."id" > ${decoded.id})
        )`);
      }
    } else {
      // Member-count cursor (members | active | relevance).
      const cursorMembers = parseInt(decoded.sortValue.replace(/^0+/, '') || '0', 10);
      if (!isNaN(cursorMembers)) {
        where.push(Prisma.sql`(
          (${memberCountExpr} < ${cursorMembers})
          OR (${memberCountExpr} = ${cursorMembers} AND s."id" > ${decoded.id})
        )`);
      }
    }
  }

  // ORDER BY clause.
  let orderBy: Prisma.Sql;
  switch (input.sort) {
    case 'new':
      orderBy = Prisma.sql`COALESCE(ss."discoverableSince", s."createdAt") DESC, s."id" ASC`;
      break;
    case 'members':
      orderBy = Prisma.sql`${memberCountExpr} DESC, s."id" ASC`;
      break;
    case 'active':
      // Best-effort fallback to members; document the limitation in the
      // public-facing changelog when active becomes a real signal.
      orderBy = Prisma.sql`${memberCountExpr} DESC, s."id" ASC`;
      break;
    case 'relevance':
    default:
      // Featured first, then verified, then members. Without a search query
      // there is no FTS rank to combine, so this is the canonical "best of"
      // ordering and matches the spec.
      orderBy = Prisma.sql`s."featured" DESC, s."verified" DESC, ${memberCountExpr} DESC, s."id" ASC`;
      break;
  }

  const whereClause = Prisma.join(where, ' AND ');

  const rows = await prisma.$queryRaw<DiscoveryQueryRow[]>(Prisma.sql`
    SELECT
      s."id" AS id,
      s."vanityUrl" AS "vanityUrl",
      s."name" AS name,
      s."icon" AS icon,
      s."banner" AS banner,
      ss."bannerSplash" AS "bannerSplash",
      ss."longDescription" AS "longDescription",
      ss."category" AS category,
      ss."subcategory" AS subcategory,
      ss."tags" AS tags,
      ss."language" AS language,
      s."verified" AS verified,
      s."featured" AS featured,
      ss."discoverableSince" AS "discoverableSince",
      s."createdAt" AS "createdAt",
      ${memberCountExpr} AS "memberCount",
      ${onlineCountExpr} AS online
    FROM "Server" s
    JOIN "ServerSettings" ss ON ss."serverId" = s."id"
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${fetchLimit}
  `);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = trimmed[trimmed.length - 1];
    nextCursor = encodeCursor(rowSortValue(last, input.sort), last.id);
  }

  return { rows: trimmed, nextCursor };
}
