-- AlterTable
ALTER TABLE "User" ADD COLUMN     "boostPaidSlots" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "boostSubscriptionId" TEXT;
