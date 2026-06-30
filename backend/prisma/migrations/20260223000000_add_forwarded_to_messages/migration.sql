-- AlterTable
ALTER TABLE "Message" ADD COLUMN "forwarded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN "forwarded" BOOLEAN NOT NULL DEFAULT false;
