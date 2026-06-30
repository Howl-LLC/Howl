-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "DMMessage_dmChannelId_id_idx" ON "DMMessage"("dmChannelId", "id");

-- CreateIndex
CREATE INDEX "DMParticipant_dmChannelId_userId_idx" ON "DMParticipant"("dmChannelId", "userId");

-- CreateIndex
CREATE INDEX "Message_channelId_id_idx" ON "Message"("channelId", "id");

-- CreateIndex
CREATE INDEX "MessageReport_status_createdAt_idx" ON "MessageReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ServerBan_bannedById_idx" ON "ServerBan"("bannedById");

-- CreateIndex
CREATE INDEX "ServerMember_serverId_userId_idx" ON "ServerMember"("serverId", "userId");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- AddForeignKey
ALTER TABLE "TrialCardFingerprint" ADD CONSTRAINT "TrialCardFingerprint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTrialSetup" ADD CONSTRAINT "PendingTrialSetup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
