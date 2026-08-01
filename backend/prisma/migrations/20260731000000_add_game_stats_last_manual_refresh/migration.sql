-- Manual game-stats refresh cooldown must be anchored to the user's last
-- MANUAL refresh, not to lastFetched: the showcase-refresh worker bumps
-- lastFetched on every automatic refresh, which (on the free plan, where the
-- manual cooldown equals the auto-refresh interval) kept the manual refresh
-- permanently on cooldown. No backfill — NULL means "never manually
-- refreshed", which allows an immediate first manual refresh.
ALTER TABLE "GameStatsCache" ADD COLUMN "lastManualRefreshAt" TIMESTAMP(3);
