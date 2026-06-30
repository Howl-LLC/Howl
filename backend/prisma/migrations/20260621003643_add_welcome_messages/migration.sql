-- Add ServerSettings.welcomeMessages — a rotating list of welcome statements.
-- A random entry is posted per new member; the legacy single `welcomeMessage`
-- stays as a fallback for un-migrated servers.
--
-- NOTE: this migration was hand-trimmed. `prisma migrate dev` also wanted to
-- DROP the `search_vector` FTS columns/indexes on Message/DMMessage and rename
-- MemberRole FK constraints — those are managed outside the Prisma schema
-- (see migration 20260408213119_add_search_vectors) and must NOT be touched.
-- When generating future migrations, use `--create-only` and strip that drift.
ALTER TABLE "ServerSettings" ADD COLUMN     "welcomeMessages" TEXT[] DEFAULT ARRAY[]::TEXT[];
