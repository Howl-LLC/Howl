-- AlterTable
ALTER TABLE "Message" ADD COLUMN "replyToMessageId" TEXT;

-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN "replyToMessageId" TEXT;
