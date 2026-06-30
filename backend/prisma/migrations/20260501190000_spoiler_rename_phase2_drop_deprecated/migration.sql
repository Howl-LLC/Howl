-- Destructive cleanup half of the spoiler rename + age-gate change.
--
-- Drops the deprecated columns left in place by the additive
-- migration. After this migration:
--   - per-attachment spoiler is the only NSFW concept on Message + DMMessage
--   - per-channel ageRestricted is the only NSFW concept on the server side
--   - the server-wide explicit-content filter is gone
--
-- This migration is destructive and irreversible. The additive migration already ran:
--   - attachmentIsSpoiler is the source-of-truth column for per-attachment
--     spoiler state on both Message and DMMessage; data was backfilled
--     from attachmentIsExplicit.
--   - For any server with nsfwLevel='mature' OR ServerSettings.ageRestricted=true,
--     all channels were already marked ageRestricted=true.
--
-- The additive migration ran at 20260501180000_spoiler_rename_phase1.

ALTER TABLE "Message"        DROP COLUMN "attachmentIsExplicit";
ALTER TABLE "DMMessage"      DROP COLUMN "attachmentIsExplicit";
ALTER TABLE "Server"         DROP COLUMN "nsfwLevel";
ALTER TABLE "ServerSettings" DROP COLUMN "ageRestricted";
ALTER TABLE "User"           DROP COLUMN "explicitContentFilter";
