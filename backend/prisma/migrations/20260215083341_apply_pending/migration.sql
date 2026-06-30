-- AlterTable
ALTER TABLE "DMChannel" ADD COLUMN     "icon" TEXT,
ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "DMParticipant" ADD COLUMN     "lastReadAt" TIMESTAMP(3);
