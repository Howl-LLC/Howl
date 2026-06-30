-- Remove E2E encryption: drop all encryption-related tables and fields

-- Drop E2E tables
DROP TABLE IF EXISTS "EncryptedKeyBackup" CASCADE;
DROP TABLE IF EXISTS "PendingArchiveDistribution" CASCADE;
DROP TABLE IF EXISTS "ChannelArchiveKey" CASCADE;
DROP TABLE IF EXISTS "PendingKeyDelivery" CASCADE;
DROP TABLE IF EXISTS "EncryptedMessageArchive" CASCADE;
DROP TABLE IF EXISTS "PendingGroupExchange" CASCADE;
DROP TABLE IF EXISTS "MegolmOutboundSession" CASCADE;
DROP TABLE IF EXISTS "UserDevice" CASCADE;
DROP TABLE IF EXISTS "KeyBundleFetch" CASCADE;
DROP TABLE IF EXISTS "UserKeyBundle" CASCADE;

-- Remove E2E backup fields from User
ALTER TABLE "User" DROP COLUMN IF EXISTS "backupSalt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "backupConfigured";
ALTER TABLE "User" DROP COLUMN IF EXISTS "backupConfiguredAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "crossSigningPublicKey";

-- Set all existing DM channels to unencrypted
UPDATE "DMChannel" SET "encrypted" = false;

-- Change default for new DM channels
ALTER TABLE "DMChannel" ALTER COLUMN "encrypted" SET DEFAULT false;
