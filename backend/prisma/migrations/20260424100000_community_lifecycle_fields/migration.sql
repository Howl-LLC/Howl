-- Community lifecycle fields (public/community-servers feature).
--
-- Designated rules / updates channel pointers used by the community-eligibility
-- and community-update endpoints. Foundation columns on Server / ServerSettings
-- (nsfwLevel, suspendedAt, category, subcategory, tags, language,
-- longDescription, bannerSplash, discoverableSince) are owned by the
-- canonical migration `20260424100000_community_servers_core`, so this
-- migration only adds the columns that one doesn't.

-- ServerSettings: designated rules/updates channels
ALTER TABLE "ServerSettings"
  ADD COLUMN "rulesChannelId" TEXT,
  ADD COLUMN "updatesChannelId" TEXT;
