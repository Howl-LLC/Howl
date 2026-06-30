-- CreateTable: UserDevice (per-user device registry for multi-device E2E)
CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "displayName" TEXT,
    "curve25519Key" TEXT NOT NULL,
    "ed25519Key" TEXT NOT NULL,
    "oneTimeKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fallbackKey" TEXT,
    "fallbackKeyPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable: MegolmOutboundSession (server-side Megolm session tracking)
CREATE TABLE "MegolmOutboundSession" (
    "id" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "senderDeviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MegolmOutboundSession_pkey" PRIMARY KEY ("id")
);

-- AlterTable: User — add crossSigningPublicKey
ALTER TABLE "User" ADD COLUMN "crossSigningPublicKey" TEXT;

-- AlterTable: UserKeyBundle — add deviceId with default for existing rows
ALTER TABLE "UserKeyBundle" ADD COLUMN "deviceId" TEXT NOT NULL DEFAULT 'legacy-device-0';

-- Drop old unique index on UserKeyBundle (userId only)
-- Note: Prisma creates unique indexes, not constraints, so use DROP INDEX
DROP INDEX IF EXISTS "UserKeyBundle_userId_key";

-- AlterTable: KeyBundleFetch — add deviceId with default for existing rows
ALTER TABLE "KeyBundleFetch" ADD COLUMN "deviceId" TEXT NOT NULL DEFAULT 'legacy-device-0';

-- Drop old unique index on KeyBundleFetch (requesterId, targetId)
DROP INDEX IF EXISTS "KeyBundleFetch_requesterId_targetId_key";

-- CreateIndex: UserDevice
CREATE UNIQUE INDEX "UserDevice_userId_deviceId_key" ON "UserDevice"("userId", "deviceId");
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");

-- CreateIndex: MegolmOutboundSession
CREATE UNIQUE INDEX "MegolmOutboundSession_dmChannelId_senderDeviceId_key" ON "MegolmOutboundSession"("dmChannelId", "senderDeviceId");
CREATE INDEX "MegolmOutboundSession_dmChannelId_idx" ON "MegolmOutboundSession"("dmChannelId");

-- CreateIndex: UserKeyBundle (new composite unique)
CREATE UNIQUE INDEX "UserKeyBundle_userId_deviceId_key" ON "UserKeyBundle"("userId", "deviceId");
CREATE INDEX "UserKeyBundle_userId_idx" ON "UserKeyBundle"("userId");

-- CreateIndex: KeyBundleFetch (new composite unique)
CREATE UNIQUE INDEX "KeyBundleFetch_requesterId_targetId_deviceId_key" ON "KeyBundleFetch"("requesterId", "targetId", "deviceId");

-- AddForeignKey: UserDevice → User
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: MegolmOutboundSession → UserDevice
ALTER TABLE "MegolmOutboundSession" ADD CONSTRAINT "MegolmOutboundSession_senderDeviceId_fkey" FOREIGN KEY ("senderDeviceId") REFERENCES "UserDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: MegolmOutboundSession → DMChannel
ALTER TABLE "MegolmOutboundSession" ADD CONSTRAINT "MegolmOutboundSession_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
