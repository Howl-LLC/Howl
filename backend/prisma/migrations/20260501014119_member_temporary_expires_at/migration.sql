-- Adds optional `temporaryExpiresAt` to ServerMember. When a member joins via a
-- `temporary: true` invite, this field captures the invite's expiresAt; the
-- cleanup worker periodically deletes rows whose snapshot has elapsed and
-- whose roleId is null. Replaces the previous "kick on socket disconnect"
-- behavior keyed on the legacy `isTemporary` boolean.
--
-- Additive only: existing rows default to NULL (no scheduled removal). Safe
-- under concurrent writes per docs/PROTOCOL_CHANGES.md.
ALTER TABLE "ServerMember" ADD COLUMN "temporaryExpiresAt" TIMESTAMP(3);

-- Index supports the periodic sweep query that scans for rows whose snapshot
-- has elapsed (`temporaryExpiresAt < NOW()`).
CREATE INDEX "ServerMember_temporaryExpiresAt_idx" ON "ServerMember"("temporaryExpiresAt");
