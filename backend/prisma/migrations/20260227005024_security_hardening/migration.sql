-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "slowMode" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "temporary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN     "isTemporary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ServerSettings" ADD COLUMN     "auditLogRetentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "messageRetentionDays" INTEGER;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "refreshTokenHash" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "badges" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "DMMessage_authorId_idx" ON "DMMessage"("authorId");

-- CreateIndex
CREATE INDEX "DMMessage_createdAt_idx" ON "DMMessage"("createdAt");

-- CreateIndex
CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE INDEX "ServerMember_serverId_idx" ON "ServerMember"("serverId");

-- CreateIndex
CREATE INDEX "Session_refreshTokenHash_idx" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
