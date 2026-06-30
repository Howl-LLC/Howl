-- Admin server T&S audit trail (Community/Public Servers).
--
-- Adds the immutable history table for admin T&S actions against servers:
-- suspend/unsuspend/hide/unhide/feature/unfeature/verify/unverify. Live
-- state continues to live on `Server.featured` / `Server.verified` /
-- `Server.hiddenFromDiscovery` / `Server.suspendedAt` / `Server.suspensionReason`
-- / `Server.suspendedById`. This table is the audit feed.
--
-- FK semantics:
--   - `serverId` cascades — audit trail is meaningless without its server.
--   - `actorId` SET NULL on admin delete so the audit trail outlives admin
--     account deletion (matches `AuditLog.actorId` invariant).

CREATE TABLE "ServerSuspension" (
  "id"        TEXT NOT NULL,
  "serverId"  TEXT NOT NULL,
  "action"    TEXT NOT NULL,
  "actorId"   TEXT,
  "reason"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServerSuspension_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServerSuspension_serverId_createdAt_idx"
  ON "ServerSuspension" ("serverId", "createdAt");

ALTER TABLE "ServerSuspension"
  ADD CONSTRAINT "ServerSuspension_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServerSuspension"
  ADD CONSTRAINT "ServerSuspension_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
