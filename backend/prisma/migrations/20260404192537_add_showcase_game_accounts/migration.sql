-- AlterTable
ALTER TABLE "User" ADD COLUMN     "showcaseLayout" JSONB;

-- CreateTable
CREATE TABLE "GameAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "platform" TEXT,
    "displayName" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameStatsCache" (
    "id" TEXT NOT NULL,
    "gameAccountId" TEXT NOT NULL,
    "rank" JSONB,
    "stats" JSONB,
    "lastFetched" TIMESTAMP(3),
    "nextRefreshAt" TIMESTAMP(3),
    "fetchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameStatsCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameAccount_userId_idx" ON "GameAccount"("userId");

-- CreateIndex
CREATE INDEX "GameAccount_provider_idx" ON "GameAccount"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "GameAccount_userId_game_key" ON "GameAccount"("userId", "game");

-- CreateIndex
CREATE UNIQUE INDEX "GameStatsCache_gameAccountId_key" ON "GameStatsCache"("gameAccountId");

-- AddForeignKey
ALTER TABLE "GameAccount" ADD CONSTRAINT "GameAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameStatsCache" ADD CONSTRAINT "GameStatsCache_gameAccountId_fkey" FOREIGN KEY ("gameAccountId") REFERENCES "GameAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
