// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Multi-role migration: seed per-server @everyone role, strip Member.permissions,
 * and backfill MemberRole from existing ServerMember.roleId assignments.
 *
 * Run from backend/: npx tsx scripts/migrate-multi-role.ts
 *
 * Invoked automatically from the Dockerfile CMD after `prisma migrate deploy`.
 * Idempotent: safe to re-run on partial completion or repeated deploys.
 *
 * Per-server transaction boundary so a crash mid-run resumes at the next server
 * without double-writes.
 */
import 'dotenv/config';
import { prisma } from '../src/db.js';
import { logger } from '../src/logger.js';

const log = logger.child({ script: 'migrate-multi-role' });

// Fallback baseline used only when a server has no "Member" role at all
// (very old data or manual deletion). Mirrors the seed in
// backend/src/routes/serverRoles.ts:50.
const FALLBACK_EVERYONE_PERMS: Record<string, boolean> = {
  viewChannels: true,
  sendMessages: true,
  readMessageHistory: true,
  embedLinks: true,
  attachFiles: true,
  addReactions: true,
  connect: true,
  speak: true,
  video: true,
  useVoiceActivity: true,
  createInvite: true,
  changeNickname: true,
  viewCalendar: true,
  requestToSpeak: true,
  createPolls: true,
  createThreads: true,
  sendMessagesInThreads: true,
  createPosts: true,
  sendMessagesInPosts: true,
};

async function migrateServer(serverId: string): Promise<{ seeded: boolean; backfilled: number }> {
  return prisma.$transaction(async (tx) => {
    // 1. Check for existing @everyone on this server.
    const existingEveryone = await tx.serverRole.findFirst({
      where: { serverId, isEveryone: true },
      select: { id: true },
    });

    let seeded = false;

    if (!existingEveryone) {
      // Find the Member role (case-insensitive name match); fall back to hardcoded baseline.
      const memberRole = await tx.serverRole.findFirst({
        where: { serverId, name: { equals: 'Member', mode: 'insensitive' }, isEveryone: false },
        select: { id: true, permissions: true },
      });

      const perms: Record<string, boolean> =
        (memberRole?.permissions as Record<string, boolean> | null) ?? FALLBACK_EVERYONE_PERMS;

      // @everyone goes at max(position)+1 — lowest in Howl's position hierarchy
      // (lower number = higher authority). Don't shift others.
      const topPos = await tx.serverRole.findMany({
        where: { serverId },
        orderBy: { position: 'desc' },
        take: 1,
        select: { position: true },
      });
      const everyonePosition = (topPos[0]?.position ?? 0) + 1;

      await tx.serverRole.create({
        data: {
          serverId,
          name: '@everyone',
          color: '#99aab5',
          style: 'solid',
          position: everyonePosition,
          locked: true,
          isEveryone: true,
          permissions: perms,
          displaySeparately: false,
          allowMention: false,
        },
      });
      seeded = true;

      // Strip Member.permissions now that @everyone carries baseline.
      if (memberRole) {
        await tx.serverRole.update({
          where: { id: memberRole.id },
          data: { permissions: {} },
        });
      }
    }

    // 2. Backfill MemberRole rows from every ServerMember.roleId.
    // ON CONFLICT DO NOTHING via raw SQL since Prisma client lacks native upsert
    // on composite keys with bulk insert. Scoped per server for speed.
    const result = await tx.$executeRaw`
      INSERT INTO "MemberRole" ("userId", "serverId", "roleId", "assignedAt", "assignedBy")
      SELECT sm."userId", sm."serverId", sm."roleId", sm."joinedAt", NULL
      FROM "ServerMember" sm
      WHERE sm."serverId" = ${serverId}
        AND sm."roleId" IS NOT NULL
      ON CONFLICT DO NOTHING
    `;

    // 3. Owner sanity check: every member whose legacy role string is 'owner'
    // must have a MemberRole row for the server's Owner role.
    const ownerRole = await tx.serverRole.findFirst({
      where: { serverId, name: { equals: 'Owner', mode: 'insensitive' }, locked: true },
      select: { id: true },
    });

    if (ownerRole) {
      await tx.$executeRaw`
        INSERT INTO "MemberRole" ("userId", "serverId", "roleId", "assignedAt", "assignedBy")
        SELECT sm."userId", sm."serverId", ${ownerRole.id}, sm."joinedAt", NULL
        FROM "ServerMember" sm
        WHERE sm."serverId" = ${serverId}
          AND LOWER(sm."role") = 'owner'
        ON CONFLICT DO NOTHING
      `;
    }

    return { seeded, backfilled: Number(result) };
  });
}

async function main() {
  const servers = await prisma.server.findMany({ select: { id: true, name: true } });
  log.info({ count: servers.length }, 'multi-role migration starting');

  let seededCount = 0;
  let totalBackfilled = 0;
  let errors = 0;

  for (const server of servers) {
    try {
      const { seeded, backfilled } = await migrateServer(server.id);
      if (seeded) seededCount++;
      totalBackfilled += backfilled;
      log.debug({ serverId: server.id, seeded, backfilled }, 'server migrated');
    } catch (err) {
      errors++;
      log.error({ err, serverId: server.id, serverName: server.name }, 'server migration failed');
    }
  }

  log.info(
    { servers: servers.length, everyoneSeeded: seededCount, memberRolesBackfilled: totalBackfilled, errors },
    'multi-role migration complete',
  );

  if (errors > 0) {
    process.exit(1);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    // Explicit exit: without this, Prisma's engine worker and/or pino's
    // background stream keep the event loop alive and the Dockerfile's
    // `&& tsx dist/src/start.js` never runs — the platform then kills the
    // container when its healthcheck window expires.
    process.exit(0);
  })
  .catch(async (err) => {
    log.error({ err }, 'migration script crashed');
    await prisma.$disconnect();
    process.exit(1);
  });
