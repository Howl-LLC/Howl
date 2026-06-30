-- DropForeignKey
ALTER TABLE "AdminAuditLog" DROP CONSTRAINT "AdminAuditLog_adminId_fkey";

-- DropIndex
DROP INDEX "AdminUser_email_key";

-- AlterTable
ALTER TABLE "AdminUser" ALTER COLUMN "emailHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN     "serverDeafened" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serverMuted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ServerSettings" ADD COLUMN     "blockedNicknames" JSONB;

-- AlterTable
ALTER TABLE "UserKeyBundle" ADD COLUMN     "registrationId" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
