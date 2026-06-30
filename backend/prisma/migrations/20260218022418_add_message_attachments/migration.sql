-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN     "attachmentContentType" TEXT,
ADD COLUMN     "attachmentName" TEXT,
ADD COLUMN     "attachmentUrl" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "attachmentContentType" TEXT,
ADD COLUMN     "attachmentName" TEXT,
ADD COLUMN     "attachmentUrl" TEXT;
