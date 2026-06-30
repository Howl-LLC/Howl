-- UserSecurityEvent audit table + emissions.
--
-- Records user-initiated security-sensitive state changes so the owning
-- user can review "did someone change my password last night?" without
-- waiting on admin support. Fire-and-forget writes from emitUserSecurityEvent
-- (services/securityEvents.ts). Cascade-deletes with the owner on GDPR
-- self-delete.

CREATE TABLE "UserSecurityEvent" (
  "id"            TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "eventType"     TEXT         NOT NULL,
  "ipMasked"      TEXT,
  "userAgentHash" TEXT,
  "metadata"      JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserSecurityEvent_pkey" PRIMARY KEY ("id")
);

-- Query pattern: list most recent events for a user, filtered to ≤90d.
-- Index mirrors the `GET /api/v1/me/security-events` query shape.
CREATE INDEX "UserSecurityEvent_userId_createdAt_idx"
  ON "UserSecurityEvent" ("userId", "createdAt" DESC);

ALTER TABLE "UserSecurityEvent"
  ADD CONSTRAINT "UserSecurityEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
