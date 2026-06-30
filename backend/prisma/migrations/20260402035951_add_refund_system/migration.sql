-- AlterTable
ALTER TABLE "User" ADD COLUMN     "hasUsedGiftRefund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasUsedPowerUpRefund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasUsedSubscriptionRefund" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "reason" TEXT,
    "initiatedBy" TEXT NOT NULL,
    "adminId" TEXT,
    "adminOverride" BOOLEAN NOT NULL DEFAULT false,
    "adminOverrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Refund_userId_idx" ON "Refund"("userId");

-- CreateIndex
CREATE INDEX "Refund_stripeChargeId_idx" ON "Refund"("stripeChargeId");

-- CreateIndex
CREATE INDEX "Refund_createdAt_idx" ON "Refund"("createdAt");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
