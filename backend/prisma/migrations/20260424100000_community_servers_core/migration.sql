-- Community Servers schema foundation: discovery,
-- vanity URLs, NSFW server flag, admin T&S (suspend/feature/verify),
-- welcome screens, apply-to-join, and per-user discovery preferences.
-- Additive only — no existing column types or defaults are modified.

-- AlterTable: User
ALTER TABLE "User"
    ADD COLUMN "explicitContentFilter" TEXT NOT NULL DEFAULT 'show',
    ADD COLUMN "discoveryOptOut"       BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Server
ALTER TABLE "Server"
    ADD COLUMN "vanityUrl"           TEXT,
    ADD COLUMN "featured"            BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verified"            BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "hiddenFromDiscovery" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "suspendedAt"         TIMESTAMP(3),
    ADD COLUMN "suspensionReason"    TEXT,
    ADD COLUMN "suspendedById"       TEXT,
    ADD COLUMN "nsfwLevel"           TEXT NOT NULL DEFAULT 'safe';

-- CreateIndex: unique vanityUrl + composite discovery filter index
CREATE UNIQUE INDEX "Server_vanityUrl_key"
    ON "Server"("vanityUrl");

CREATE INDEX "Server_featured_hiddenFromDiscovery_suspendedAt_idx"
    ON "Server"("featured", "hiddenFromDiscovery", "suspendedAt");

-- AlterTable: ServerSettings
ALTER TABLE "ServerSettings"
    ADD COLUMN "category"                 TEXT,
    ADD COLUMN "subcategory"              TEXT,
    ADD COLUMN "tags"                     JSONB,
    ADD COLUMN "language"                 TEXT NOT NULL DEFAULT 'en',
    ADD COLUMN "bannerSplash"             TEXT,
    ADD COLUMN "longDescription"          TEXT,
    ADD COLUMN "discoverableSince"        TIMESTAMP(3),
    ADD COLUMN "welcomeScreenEnabled"     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "welcomeScreenDescription" TEXT,
    ADD COLUMN "applicationQuestions"     JSONB;
