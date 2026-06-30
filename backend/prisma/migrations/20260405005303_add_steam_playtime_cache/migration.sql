-- AlterTable
ALTER TABLE "User" ADD COLUMN     "steamPlaytimeData" JSONB,
ADD COLUMN     "steamPlaytimeFetchedAt" TIMESTAMP(3);
