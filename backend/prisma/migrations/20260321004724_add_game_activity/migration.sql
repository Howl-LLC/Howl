-- AlterTable
ALTER TABLE "SsoAccount" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "displayName" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shareDetectedGames" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "shareSteamActivity" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showCurrentActivity" TEXT NOT NULL DEFAULT 'everyone';

-- CreateTable
CREATE TABLE "UserActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "details" TEXT,
    "state" TEXT,
    "largeImage" TEXT,
    "smallImage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platformId" TEXT,
    "platform" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserActivity_userId_key" ON "UserActivity"("userId");

-- CreateIndex
CREATE INDEX "UserActivity_userId_idx" ON "UserActivity"("userId");

-- AddForeignKey
ALTER TABLE "UserActivity" ADD CONSTRAINT "UserActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
