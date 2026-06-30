-- AlterTable
ALTER TABLE "ChannelArchiveKey" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN     "attachmentHeight" INTEGER,
ADD COLUMN     "attachmentWidth" INTEGER;

-- AlterTable
ALTER TABLE "EncryptedMessageArchive" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "attachmentHeight" INTEGER,
ADD COLUMN     "attachmentWidth" INTEGER;

-- AlterTable
ALTER TABLE "PendingArchiveDistribution" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PendingKeyDelivery" ALTER COLUMN "id" DROP DEFAULT;
