-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shareSpotifyActivity" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "activitySourcePriority" SET DEFAULT 'steam,spotify,detected,custom,bio';

-- CreateTable
CREATE TABLE "ConnectedApp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectedApp_userId_idx" ON "ConnectedApp"("userId");

-- CreateIndex
CREATE INDEX "ConnectedApp_provider_idx" ON "ConnectedApp"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedApp_provider_providerId_key" ON "ConnectedApp"("provider", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedApp_userId_provider_key" ON "ConnectedApp"("userId", "provider");

-- AddForeignKey
ALTER TABLE "ConnectedApp" ADD CONSTRAINT "ConnectedApp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
