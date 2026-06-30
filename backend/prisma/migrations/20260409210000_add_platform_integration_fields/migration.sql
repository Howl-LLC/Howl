-- AlterTable: Add Twitch/YouTube activity sharing preferences to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "shareTwitchActivity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "shareYouTubeActivity" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: Add profile data caching fields to ConnectedApp
ALTER TABLE "ConnectedApp" ADD COLUMN IF NOT EXISTS "profileData" JSONB;
ALTER TABLE "ConnectedApp" ADD COLUMN IF NOT EXISTS "profileFetchedAt" TIMESTAMP(3);
ALTER TABLE "ConnectedApp" ADD COLUMN IF NOT EXISTS "nextProfileRefreshAt" TIMESTAMP(3);
