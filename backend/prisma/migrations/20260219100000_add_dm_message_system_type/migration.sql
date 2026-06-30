-- AlterTable
ALTER TABLE "DMMessage" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'message';
ALTER TABLE "DMMessage" ADD COLUMN "systemPayload" JSONB;
