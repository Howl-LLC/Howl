-- DropForeignKey
ALTER TABLE "AdminAuditLog" DROP CONSTRAINT "AdminAuditLog_adminId_fkey";

-- DropIndex
DROP INDEX "AutomodRule_serverId_idx";

-- CreateTable
CREATE TABLE "GiftSubscription" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT,
    "recipientUsername" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "stripePaymentIntentId" TEXT,

    CONSTRAINT "GiftSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT,
    "deviceName" TEXT NOT NULL DEFAULT 'Unknown device',
    "os" TEXT NOT NULL DEFAULT 'Unknown',
    "ip" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftSubscription_code_key" ON "GiftSubscription"("code");

-- CreateIndex
CREATE INDEX "GiftSubscription_senderId_idx" ON "GiftSubscription"("senderId");

-- CreateIndex
CREATE INDEX "GiftSubscription_recipientId_idx" ON "GiftSubscription"("recipientId");

-- CreateIndex
CREATE INDEX "GiftSubscription_status_idx" ON "GiftSubscription"("status");

-- CreateIndex
CREATE INDEX "GiftSubscription_expiresAt_idx" ON "GiftSubscription"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_idx" ON "AdminSession"("adminUserId");

-- CreateIndex
CREATE INDEX "AdminSession_tokenHash_idx" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_refreshTokenHash_idx" ON "AdminSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AutomodRule_serverId_enabled_idx" ON "AutomodRule"("serverId", "enabled");

-- CreateIndex
CREATE INDEX "Block_blockedUserId_idx" ON "Block"("blockedUserId");

-- CreateIndex
CREATE INDEX "Channel_serverId_type_idx" ON "Channel"("serverId", "type");

-- CreateIndex
CREATE INDEX "Channel_type_idx" ON "Channel"("type");

-- CreateIndex
CREATE INDEX "DMMessage_dmChannelId_createdAt_idx" ON "DMMessage"("dmChannelId", "createdAt");

-- CreateIndex
CREATE INDEX "DMMessage_authorId_createdAt_idx" ON "DMMessage"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "DMMessage_replyToMessageId_idx" ON "DMMessage"("replyToMessageId");

-- CreateIndex
CREATE INDEX "DMParticipant_dmChannelId_idx" ON "DMParticipant"("dmChannelId");

-- CreateIndex
CREATE INDEX "FamilyLink_childId_status_idx" ON "FamilyLink"("childId", "status");

-- CreateIndex
CREATE INDEX "Invite_serverId_idx" ON "Invite"("serverId");

-- CreateIndex
CREATE INDEX "Invite_expiresAt_idx" ON "Invite"("expiresAt");

-- CreateIndex
CREATE INDEX "Invite_createdById_idx" ON "Invite"("createdById");

-- CreateIndex
CREATE INDEX "Invite_serverId_createdAt_idx" ON "Invite"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_authorId_createdAt_idx" ON "Message"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_replyToMessageId_idx" ON "Message"("replyToMessageId");

-- CreateIndex
CREATE INDEX "Server_boostCount_idx" ON "Server"("boostCount");

-- CreateIndex
CREATE INDEX "Server_createdAt_idx" ON "Server"("createdAt");

-- CreateIndex
CREATE INDEX "ServerBan_userId_idx" ON "ServerBan"("userId");

-- CreateIndex
CREATE INDEX "ServerMember_serverId_joinedAt_idx" ON "ServerMember"("serverId", "joinedAt");

-- CreateIndex
CREATE INDEX "ServerMember_userId_isTemporary_idx" ON "ServerMember"("userId", "isTemporary");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Session_userId_lastActiveAt_idx" ON "Session"("userId", "lastActiveAt");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- AddForeignKey
ALTER TABLE "GiftSubscription" ADD CONSTRAINT "GiftSubscription_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftSubscription" ADD CONSTRAINT "GiftSubscription_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
