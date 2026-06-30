-- AlterTable
ALTER TABLE "Message" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'message';
ALTER TABLE "Message" ADD COLUMN "systemPayload" JSONB;
