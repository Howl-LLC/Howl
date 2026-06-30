-- AlterTable
ALTER TABLE "User" ADD COLUMN "hasUsedTrial" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TrialCardFingerprint" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "plan" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrialCardFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrialCardFingerprint_fingerprint_key" ON "TrialCardFingerprint"("fingerprint");

-- CreateIndex
CREATE INDEX "TrialCardFingerprint_fingerprint_idx" ON "TrialCardFingerprint"("fingerprint");

-- CreateIndex
CREATE INDEX "TrialCardFingerprint_userId_idx" ON "TrialCardFingerprint"("userId");
