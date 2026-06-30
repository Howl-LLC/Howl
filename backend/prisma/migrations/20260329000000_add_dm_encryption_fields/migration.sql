-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN "contentIv" TEXT;
ALTER TABLE "DMMessage" ADD COLUMN "encryptionVersion" INTEGER NOT NULL DEFAULT 1;
