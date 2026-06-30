-- Community/Public Servers: server-level T&S reports.
--
-- Lets a member flag an entire server (spam, harassment hub, illegal content,
-- undeclared NSFW, impersonation). Distinct from MessageReport (per-message);
-- both feed the admin T&S queue. Reporter identity is preserved across reporter
-- self-delete via ON DELETE SET NULL so the moderator audit trail survives.

CREATE TABLE "ServerReport" (
    "id"          TEXT NOT NULL,
    "serverId"    TEXT NOT NULL,
    -- Nullable so the report survives reporter self-delete (audit trail outlives the reporter).
    "reporterId"  TEXT,
    "reason"      TEXT NOT NULL,
    "details"     TEXT,
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "actionTaken" TEXT,
    "reviewerId"  TEXT,
    "reviewedAt"  TIMESTAMP(3),
    "reviewNote"  TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerReport_pkey" PRIMARY KEY ("id")
);

-- Hot-path index — admin queue filters by status, server-detail page filters
-- by (serverId, status), reporter dedupe lookup uses (reporterId).
CREATE INDEX "ServerReport_serverId_status_idx" ON "ServerReport"("serverId", "status");
CREATE INDEX "ServerReport_status_createdAt_idx" ON "ServerReport"("status", "createdAt");
CREATE INDEX "ServerReport_reporterId_idx" ON "ServerReport"("reporterId");

-- Cascade on server delete (the report is meaningless without its target).
ALTER TABLE "ServerReport"
    ADD CONSTRAINT "ServerReport_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull on reporter / reviewer delete so the audit trail outlives both.
ALTER TABLE "ServerReport"
    ADD CONSTRAINT "ServerReport_reporterId_fkey"
    FOREIGN KEY ("reporterId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ServerReport"
    ADD CONSTRAINT "ServerReport_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
