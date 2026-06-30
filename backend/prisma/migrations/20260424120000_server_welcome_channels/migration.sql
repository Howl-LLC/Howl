-- Welcome screen (public/community-servers).
--
-- Adds the on/off toggle + description to ServerSettings (additive, merges
-- cleanly with the rest of the discovery columns) and the new
-- `ServerWelcomeChannel` model that backs the curated channel list shown to
-- new members on first join.
--
-- All additions are non-breaking: every new column is nullable or has a
-- default, and the new table is independent of existing rows. `IF NOT EXISTS`
-- guards make the migration safe to re-run when the community-servers core
-- migration lands the same `welcomeScreen*` columns first — Postgres will
-- skip the duplicate ADD COLUMN without erroring.

-- ── ServerSettings: welcome-screen toggle + description ────────────────────
ALTER TABLE "ServerSettings"
  ADD COLUMN IF NOT EXISTS "welcomeScreenEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "welcomeScreenDescription" TEXT;

-- ── ServerWelcomeChannel: curated channel grid (≤5 per server) ─────────────
CREATE TABLE IF NOT EXISTS "ServerWelcomeChannel" (
  "id"          TEXT         NOT NULL,
  "serverId"    TEXT         NOT NULL,
  "channelId"   TEXT         NOT NULL,
  "description" TEXT         NOT NULL,
  "emoji"       TEXT,
  "position"    INTEGER      NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ServerWelcomeChannel_pkey" PRIMARY KEY ("id")
);

-- One row per (server, channel) pair — re-adding the same channel is a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "ServerWelcomeChannel_serverId_channelId_key"
  ON "ServerWelcomeChannel" ("serverId", "channelId");

-- Hot-path index for ordered reads: GET /welcome always sorts by position
-- within a server. Composite (serverId, position) lets Postgres serve the
-- read straight from the index.
CREATE INDEX IF NOT EXISTS "ServerWelcomeChannel_serverId_position_idx"
  ON "ServerWelcomeChannel" ("serverId", "position");

-- Cascade deletes: dropping a server or channel must remove its welcome rows.
ALTER TABLE "ServerWelcomeChannel"
  ADD CONSTRAINT "ServerWelcomeChannel_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServerWelcomeChannel"
  ADD CONSTRAINT "ServerWelcomeChannel_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
