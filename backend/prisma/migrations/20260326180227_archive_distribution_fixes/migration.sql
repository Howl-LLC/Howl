-- AlterTable: Add claim tracking to ChannelArchiveKey
ALTER TABLE "ChannelArchiveKey" ADD COLUMN "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ChannelArchiveKey" ADD COLUMN "distributed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: PendingArchiveDistribution
CREATE TABLE "PendingArchiveDistribution" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "newDeviceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingArchiveDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingArchiveDistribution_userId_newDeviceId_key" ON "PendingArchiveDistribution"("userId", "newDeviceId");
CREATE INDEX "PendingArchiveDistribution_userId_idx" ON "PendingArchiveDistribution"("userId");
CREATE INDEX "PendingArchiveDistribution_createdAt_idx" ON "PendingArchiveDistribution"("createdAt");
