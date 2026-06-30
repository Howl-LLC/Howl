-- AlterTable: per-user ordering for the far-left server nav. Replaces the
-- localStorage-only scheme so the order follows the user across devices.
-- Default is a deliberately huge number so new memberships (created via
-- server-create, invite accept, application accept) land at the bottom of
-- the user's sidebar rather than colliding with the hand-picked top slot at
-- 0. The reorder endpoint always writes 0..N-1, so the default never
-- collides with an actively-positioned server.
ALTER TABLE "ServerMember" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 1000000;

-- CreateIndex: lookup by (userId, position) for the slim getServers payload
CREATE INDEX "ServerMember_userId_position_idx" ON "ServerMember"("userId", "position");

-- Backfill: assign positions per user using joinedAt order so existing
-- members keep a stable, sensible order on first load. Servers a user
-- joined earliest sit at the top.
WITH ranked AS (
  SELECT "userId", "serverId",
         ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "joinedAt" ASC) - 1 AS pos
  FROM "ServerMember"
)
UPDATE "ServerMember" SET "position" = ranked.pos
FROM ranked
WHERE "ServerMember"."userId" = ranked."userId"
  AND "ServerMember"."serverId" = ranked."serverId";
