-- Add group-DM owner column.
--
-- NOTE: this migration was hand-trimmed. `prisma migrate dev` wanted to also
-- DROP the `search_vector` FTS columns/indexes on Message/DMMessage and rename
-- MemberRole FK constraints — those are managed outside the Prisma schema
-- (see migration 20260408213119_add_search_vectors) and must NOT be dropped.
-- When generating future migrations, use `--create-only` and strip that drift.
ALTER TABLE "DMChannel" ADD COLUMN "ownerId" TEXT;

-- Backfill: earliest-joined participant becomes owner of each existing group DM.
UPDATE "DMChannel" c
SET "ownerId" = (
  SELECT p."userId"
  FROM "DMParticipant" p
  WHERE p."dmChannelId" = c."id"
  ORDER BY p."joinedAt" ASC, p."userId" ASC
  LIMIT 1
)
WHERE c."isGroup" = true AND c."ownerId" IS NULL;
