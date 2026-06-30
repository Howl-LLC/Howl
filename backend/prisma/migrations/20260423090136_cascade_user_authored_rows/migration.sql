-- Add @relation + ON DELETE Cascade/SetNull to user-authored
-- and user-uploaded columns. Before this migration, these columns were bare
-- strings with no FK constraint, so there was no referential-integrity
-- guarantee at the DB level. The GDPR deletion flow used a sentinel string
-- `'deleted'` for many of these columns (e.g. `authorId = 'deleted'`) to mark
-- orphaned content.
--
-- This migration has three phases so the FK ADDs succeed against existing
-- production data:
--   1. Relax NOT NULL on columns that will use ON DELETE SET NULL.
--   2. Null out the sentinel `'deleted'` marker in those columns so the new
--      FK doesn't fail to match against the non-existent user.
--   3. Delete rows where the user-FK column points at a non-existent user
--      (sentinel `'deleted'` under Cascade semantics, plus any prior orphans
--      from pre-FK schema drift). Under the new invariant these rows would
--      have been cascaded away when the user was deleted; this one-time
--      cleanup brings pre-migration data in line.
--   4. Drop/re-add any existing FKs that need onDelete changes.
--   5. Add all new FK constraints.

-- ── Step 1: relax NOT NULL on SetNull columns ─────────────────────────────

ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "ChannelPinnedMessage" ALTER COLUMN "pinnedById" DROP NOT NULL;
ALTER TABLE "DMPinnedMessage" ALTER COLUMN "pinnedById" DROP NOT NULL;
ALTER TABLE "MessageReport" ALTER COLUMN "reporterId" DROP NOT NULL;

-- ── Step 2: scrub 'deleted' sentinel in SetNull columns ───────────────────
-- These rows were written by the pre-FK GDPR loop; they're moderation-audit
-- bearing and should be preserved with NULL actor/reporter.

UPDATE "AuditLog" SET "actorId" = NULL WHERE "actorId" = 'deleted';

-- ── Step 3: delete orphans referenced by Cascade columns ──────────────────
-- Any row whose author/uploader column points at a user that no longer exists
-- would block the FK ADD. Under the new invariant these rows would have been
-- cascaded out when the user was deleted, so this is consistent cleanup.

DELETE FROM "Message" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "DMMessage" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "ThreadMessage" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "Thread" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "Poll" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "ForumPost" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "ForumMessage" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "CustomEmoji" WHERE "uploadedById" NOT IN (SELECT "id" FROM "User");
DELETE FROM "Sticker" WHERE "uploadedById" NOT IN (SELECT "id" FROM "User");
DELETE FROM "SoundboardSound" WHERE "uploadedById" NOT IN (SELECT "id" FROM "User");
DELETE FROM "MessageReport" WHERE "authorId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "PendingKeyDelivery" WHERE "recipientId" NOT IN (SELECT "id" FROM "User");

-- SetNull-column orphan cleanup (null the FK column where the user is gone).
-- We already handled AuditLog.actorId = 'deleted' above; catch any other
-- orphan values defensively.
UPDATE "AuditLog" SET "actorId" = NULL WHERE "actorId" IS NOT NULL AND "actorId" NOT IN (SELECT "id" FROM "User");
UPDATE "ChannelPinnedMessage" SET "pinnedById" = NULL WHERE "pinnedById" IS NOT NULL AND "pinnedById" NOT IN (SELECT "id" FROM "User");
UPDATE "DMPinnedMessage" SET "pinnedById" = NULL WHERE "pinnedById" IS NOT NULL AND "pinnedById" NOT IN (SELECT "id" FROM "User");
UPDATE "MessageReport" SET "reporterId" = NULL WHERE "reporterId" IS NOT NULL AND "reporterId" NOT IN (SELECT "id" FROM "User");
UPDATE "ServerEvent" SET "createdById" = NULL WHERE "createdById" IS NOT NULL AND "createdById" NOT IN (SELECT "id" FROM "User");
UPDATE "PendingKeyDelivery" SET "senderId" = NULL WHERE "senderId" IS NOT NULL AND "senderId" NOT IN (SELECT "id" FROM "User");
UPDATE "GiftSubscription" SET "recipientId" = NULL WHERE "recipientId" IS NOT NULL AND "recipientId" NOT IN (SELECT "id" FROM "User");

-- GiftSubscription.senderId is Cascade and currently has an FK (NO ACTION).
-- If any orphans exist despite the FK, they'd block the FK swap — clean them
-- up. (Expected zero rows; defensive.)
DELETE FROM "GiftSubscription" WHERE "senderId" NOT IN (SELECT "id" FROM "User");

-- ── Step 4: drop existing FK on GiftSubscription.senderId (currently
--    NO ACTION) so we can re-add with ON DELETE CASCADE. Same for recipientId
--    (currently NO ACTION) so we can re-add with SET NULL.

ALTER TABLE "GiftSubscription" DROP CONSTRAINT IF EXISTS "GiftSubscription_senderId_fkey";
ALTER TABLE "GiftSubscription" DROP CONSTRAINT IF EXISTS "GiftSubscription_recipientId_fkey";

-- ── Step 5: add all new / re-added FK constraints ─────────────────────────

ALTER TABLE "GiftSubscription" ADD CONSTRAINT "GiftSubscription_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GiftSubscription" ADD CONSTRAINT "GiftSubscription_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomEmoji" ADD CONSTRAINT "CustomEmoji_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Sticker" ADD CONSTRAINT "Sticker_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SoundboardSound" ADD CONSTRAINT "SoundboardSound_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPinnedMessage" ADD CONSTRAINT "ChannelPinnedMessage_pinnedById_fkey"
  FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DMPinnedMessage" ADD CONSTRAINT "DMPinnedMessage_pinnedById_fkey"
  FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DMMessage" ADD CONSTRAINT "DMMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_reporterId_fkey"
  FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServerEvent" ADD CONSTRAINT "ServerEvent_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PendingKeyDelivery" ADD CONSTRAINT "PendingKeyDelivery_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PendingKeyDelivery" ADD CONSTRAINT "PendingKeyDelivery_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Poll" ADD CONSTRAINT "Poll_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Thread" ADD CONSTRAINT "Thread_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ThreadMessage" ADD CONSTRAINT "ThreadMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ForumMessage" ADD CONSTRAINT "ForumMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
