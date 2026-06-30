-- AlterTable
ALTER TABLE "EventReminder" ADD COLUMN     "lastFiredForOccurrence" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ServerEvent" ADD COLUMN     "recurrenceDays" JSONB,
ADD COLUMN     "recurrenceEndDate" TIMESTAMP(3),
ADD COLUMN     "recurrenceRule" TEXT DEFAULT 'NONE',
ADD COLUMN     "voiceChannelId" TEXT;
