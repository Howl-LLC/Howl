-- Rename columns (data-preserving) instead of DROP+CREATE

-- User table
ALTER TABLE "User" RENAME COLUMN "boostSubscriptionId" TO "powerUpSubscriptionId";
ALTER TABLE "User" RENAME COLUMN "boostPaidSlots" TO "powerUpPaidSlots";

-- Server table
ALTER TABLE "Server" RENAME COLUMN "boostCount" TO "powerUpCount";
ALTER TABLE "Server" RENAME COLUMN "boostStatus" TO "powerUpStatus";
ALTER TABLE "Server" RENAME COLUMN "boostPeriodEnd" TO "powerUpPeriodEnd";

-- Rename ServerBoost table to ServerPowerUp
ALTER TABLE "ServerBoost" RENAME TO "ServerPowerUp";

-- Rename constraints
ALTER TABLE "ServerPowerUp" RENAME CONSTRAINT "ServerBoost_pkey" TO "ServerPowerUp_pkey";
ALTER TABLE "ServerPowerUp" RENAME CONSTRAINT "ServerBoost_serverId_fkey" TO "ServerPowerUp_serverId_fkey";
ALTER TABLE "ServerPowerUp" RENAME CONSTRAINT "ServerBoost_userId_fkey" TO "ServerPowerUp_userId_fkey";

-- Rename indexes
ALTER INDEX "ServerBoost_userId_idx" RENAME TO "ServerPowerUp_userId_idx";
ALTER INDEX "ServerBoost_serverId_idx" RENAME TO "ServerPowerUp_serverId_idx";
ALTER INDEX "Server_boostCount_idx" RENAME TO "Server_powerUpCount_idx";
