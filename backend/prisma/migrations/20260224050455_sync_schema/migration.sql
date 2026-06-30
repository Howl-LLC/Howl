-- AlterTable
ALTER TABLE "DMChannel" ADD COLUMN     "isGroup" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN     "editedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FamilyLink" ADD COLUMN     "unlinkRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "editedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "boostCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN     "allowDirectMessages" BOOLEAN,
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "serverAvatar" TEXT,
ADD COLUMN     "serverBanner" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarEffect" TEXT,
ADD COLUMN     "lastDiscriminatorChange" TIMESTAMP(3),
ADD COLUMN     "nameColor" TEXT,
ADD COLUMN     "nameEffect" TEXT,
ADD COLUMN     "nameFont" TEXT,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerBoost" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerBoost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminId_idx" ON "AdminAuditLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetUserId_idx" ON "AdminAuditLog"("targetUserId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "ServerBoost_userId_idx" ON "ServerBoost"("userId");

-- CreateIndex
CREATE INDEX "ServerBoost_serverId_idx" ON "ServerBoost"("serverId");

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerBoost" ADD CONSTRAINT "ServerBoost_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerBoost" ADD CONSTRAINT "ServerBoost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
