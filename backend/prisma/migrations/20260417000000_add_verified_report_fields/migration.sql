-- AlterTable
ALTER TABLE "MessageReport" ADD COLUMN     "channelKey" TEXT,
ADD COLUMN     "verificationState" TEXT,
ADD COLUMN     "contentSource" TEXT NOT NULL DEFAULT 'server';
