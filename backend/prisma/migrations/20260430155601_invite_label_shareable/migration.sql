-- Adds optional `label` and a `shareable` flag to Invite. Both fields are
-- additive: existing rows default to label = NULL and shareable = false, so
-- the migration is safe under concurrent writes per docs/PROTOCOL_CHANGES.md.
ALTER TABLE "Invite" ADD COLUMN "label" TEXT;
ALTER TABLE "Invite" ADD COLUMN "shareable" BOOLEAN NOT NULL DEFAULT false;

-- Compound index supports the picker query that filters by serverId and
-- shareable for non-admins (`shareable = true OR createdById = me`).
CREATE INDEX "Invite_serverId_shareable_idx" ON "Invite"("serverId", "shareable");
