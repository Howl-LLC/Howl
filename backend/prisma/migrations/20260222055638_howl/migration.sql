/*
  Warnings:

  - A unique constraint covering the columns `[stripeCustomerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "DMParticipant" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinnedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "allowDmFromServerMembers" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifyCode" TEXT,
ADD COLUMN     "emailVerifyExpiry" TIMESTAMP(3),
ADD COLUMN     "friendRequestsEveryone" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "friendRequestsFriendsOfFriends" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "friendRequestsServerMembers" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "messageRequestsFilter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaPhone" TEXT,
ADD COLUMN     "mfaPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaTotpSecret" TEXT,
ADD COLUMN     "notifyDesktop" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyDisableAllSounds" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifySoundCurrentChannel" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifySoundIncomingRing" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifySoundNewMessage" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyTaskbarFlash" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyUnreadBadge" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripePeriodEnd" TIMESTAMP(3),
ADD COLUMN     "stripePlan" TEXT,
ADD COLUMN     "stripeStatus" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SsoAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "email" TEXT,

    CONSTRAINT "SsoAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "deviceType" TEXT NOT NULL DEFAULT 'singleDevice',
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "transports" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL DEFAULT 'My Passkey',

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL DEFAULT 'Unknown device',
    "deviceType" TEXT NOT NULL DEFAULT 'web',
    "os" TEXT NOT NULL DEFAULT 'Unknown',
    "ip" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyLink" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FamilyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyRestriction" (
    "id" TEXT NOT NULL,
    "familyLinkId" TEXT NOT NULL,
    "blockDmFromNonFriends" BOOLEAN NOT NULL DEFAULT false,
    "blockServerJoin" BOOLEAN NOT NULL DEFAULT false,
    "dailyTimeLimitMinutes" INTEGER,

    CONSTRAINT "FamilyRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerSettings" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "description" TEXT,
    "verificationLevel" TEXT NOT NULL DEFAULT 'none',
    "contentFilter" TEXT NOT NULL DEFAULT 'off',
    "dmSpamFilter" BOOLEAN NOT NULL DEFAULT false,
    "welcomeMessage" TEXT,
    "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultNotifications" TEXT NOT NULL DEFAULT 'all',
    "joinMethod" TEXT NOT NULL DEFAULT 'invite_only',
    "ageRestricted" BOOLEAN NOT NULL DEFAULT false,
    "rules" JSONB,
    "communityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "discoveryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerBan" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "bannedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerBan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomEmoji" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomEmoji_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sticker" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "description" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sticker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoundboardSound" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "emoji" TEXT,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoundboardSound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomodRule" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomodRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerTemplate" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT NOT NULL,
    "channelSnapshot" JSONB,
    "roleSnapshot" JSONB,
    "createdById" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SsoAccount_userId_idx" ON "SsoAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SsoAccount_provider_providerId_key" ON "SsoAccount"("provider", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_tokenHash_idx" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "FamilyLink_parentId_idx" ON "FamilyLink"("parentId");

-- CreateIndex
CREATE INDEX "FamilyLink_childId_idx" ON "FamilyLink"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyLink_parentId_childId_key" ON "FamilyLink"("parentId", "childId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyRestriction_familyLinkId_key" ON "FamilyRestriction"("familyLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerSettings_serverId_key" ON "ServerSettings"("serverId");

-- CreateIndex
CREATE INDEX "ServerBan_serverId_idx" ON "ServerBan"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerBan_serverId_userId_key" ON "ServerBan"("serverId", "userId");

-- CreateIndex
CREATE INDEX "AuditLog_serverId_createdAt_idx" ON "AuditLog"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_serverId_action_idx" ON "AuditLog"("serverId", "action");

-- CreateIndex
CREATE INDEX "CustomEmoji_serverId_idx" ON "CustomEmoji"("serverId");

-- CreateIndex
CREATE INDEX "Sticker_serverId_idx" ON "Sticker"("serverId");

-- CreateIndex
CREATE INDEX "SoundboardSound_serverId_idx" ON "SoundboardSound"("serverId");

-- CreateIndex
CREATE INDEX "AutomodRule_serverId_idx" ON "AutomodRule"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerTemplate_code_key" ON "ServerTemplate"("code");

-- CreateIndex
CREATE INDEX "ServerTemplate_serverId_idx" ON "ServerTemplate"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "SsoAccount" ADD CONSTRAINT "SsoAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyLink" ADD CONSTRAINT "FamilyLink_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyLink" ADD CONSTRAINT "FamilyLink_childId_fkey" FOREIGN KEY ("childId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyRestriction" ADD CONSTRAINT "FamilyRestriction_familyLinkId_fkey" FOREIGN KEY ("familyLinkId") REFERENCES "FamilyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSettings" ADD CONSTRAINT "ServerSettings_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerBan" ADD CONSTRAINT "ServerBan_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomEmoji" ADD CONSTRAINT "CustomEmoji_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sticker" ADD CONSTRAINT "Sticker_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoundboardSound" ADD CONSTRAINT "SoundboardSound_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomodRule" ADD CONSTRAINT "AutomodRule_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerTemplate" ADD CONSTRAINT "ServerTemplate_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
