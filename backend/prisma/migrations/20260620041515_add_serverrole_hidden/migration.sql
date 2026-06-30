-- Add ServerRole.hidden — DISPLAY-only strip for non-mods (role list, member
-- list, myRoles, mention typeahead, realtime events). Hidden never touches
-- authorization; a hidden role's permissions still apply.
--
-- NOTE: this migration was hand-trimmed. `prisma migrate dev` wanted to also
-- DROP the `search_vector` FTS columns/indexes on Message/DMMessage and rename
-- MemberRole FK constraints — those are managed outside the Prisma schema
-- (see migration 20260408213119_add_search_vectors) and must NOT be touched.
-- When generating future migrations, use `--create-only` and strip that drift.
ALTER TABLE "ServerRole" ADD COLUMN     "hidden" BOOLEAN NOT NULL DEFAULT false;
