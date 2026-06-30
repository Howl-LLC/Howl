-- Apply-to-join backend flow.
--
-- Adds the ServerApplication model + a `applicationQuestions` JSON column on
-- ServerSettings (owned by the community-servers core migration, gap-filled
-- here for environments where that migration has not yet landed). All
-- additions are non-destructive: every new column is nullable and the new
-- table has no foreign-key dependents.

-- ── ServerSettings: question schema for apply-to-join ──────────────────────
ALTER TABLE "ServerSettings"
  ADD COLUMN IF NOT EXISTS "applicationQuestions" JSONB;

-- ── ServerApplication ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ServerApplication" (
    "id"           TEXT NOT NULL,
    "serverId"     TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "answers"      JSONB NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'pending',
    "reviewerId"   TEXT,
    "decidedAt"    TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerApplication_pkey" PRIMARY KEY ("id")
);

-- (serverId, userId, status) prevents duplicate pending or duplicate decided
-- rows for the same applicant — withdraw → re-apply works because status
-- transitions to a unique combination.
CREATE UNIQUE INDEX IF NOT EXISTS "ServerApplication_serverId_userId_status_key"
  ON "ServerApplication" ("serverId", "userId", "status");

-- Reviewer queue: filter by server + status, sort by createdAt.
CREATE INDEX IF NOT EXISTS "ServerApplication_serverId_status_createdAt_idx"
  ON "ServerApplication" ("serverId", "status", "createdAt");

-- "What did I apply to?" lookup.
CREATE INDEX IF NOT EXISTS "ServerApplication_userId_status_idx"
  ON "ServerApplication" ("userId", "status");

ALTER TABLE "ServerApplication"
  ADD CONSTRAINT "ServerApplication_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServerApplication"
  ADD CONSTRAINT "ServerApplication_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServerApplication"
  ADD CONSTRAINT "ServerApplication_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
