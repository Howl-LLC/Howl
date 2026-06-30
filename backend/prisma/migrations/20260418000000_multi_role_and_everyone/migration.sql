-- Multi-role permissions with @everyone baseline.
--
-- Schema-only changes here (DDL). Data backfill (seeding @everyone per server,
-- clearing Member.permissions, populating MemberRole from ServerMember.roleId)
-- runs afterward via backend/scripts/migrate-multi-role.ts, invoked from the
-- Dockerfile entrypoint. That script is idempotent and safe to re-run.

-- 1. Add isEveryone flag to ServerRole.
ALTER TABLE "ServerRole" ADD COLUMN "isEveryone" BOOLEAN NOT NULL DEFAULT false;

-- 2. Partial unique index: at most one @everyone role per server.
CREATE UNIQUE INDEX "ServerRole_one_everyone_per_server"
  ON "ServerRole"("serverId")
  WHERE "isEveryone" = true;

-- 3. Supporting composite index for @everyone lookups per server.
CREATE INDEX "ServerRole_serverId_isEveryone_idx"
  ON "ServerRole"("serverId", "isEveryone");

-- 4. MemberRole join table — many-to-many ServerMember <-> ServerRole.
CREATE TABLE "MemberRole" (
  "userId"     TEXT         NOT NULL,
  "serverId"   TEXT         NOT NULL,
  "roleId"     TEXT         NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedBy" TEXT,

  CONSTRAINT "MemberRole_pkey" PRIMARY KEY ("userId", "serverId", "roleId")
);

CREATE INDEX "MemberRole_userId_serverId_idx" ON "MemberRole"("userId", "serverId");
CREATE INDEX "MemberRole_roleId_idx"          ON "MemberRole"("roleId");
CREATE INDEX "MemberRole_serverId_roleId_idx" ON "MemberRole"("serverId", "roleId");

ALTER TABLE "MemberRole"
  ADD CONSTRAINT "MemberRole_member_fk"
  FOREIGN KEY ("userId", "serverId")
  REFERENCES "ServerMember"("userId", "serverId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemberRole"
  ADD CONSTRAINT "MemberRole_role_fk"
  FOREIGN KEY ("roleId")
  REFERENCES "ServerRole"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
