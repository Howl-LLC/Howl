-- CreateTable
CREATE TABLE "PendingTrialSetup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "trialResult" TEXT,
    "resultMessage" TEXT,
    "paymentMethodId" TEXT,
    "fingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PendingTrialSetup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingTrialSetup_stripeCheckoutSessionId_key" ON "PendingTrialSetup"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "PendingTrialSetup_userId_idx" ON "PendingTrialSetup"("userId");

-- CreateIndex
CREATE INDEX "PendingTrialSetup_stripeCheckoutSessionId_idx" ON "PendingTrialSetup"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "PendingTrialSetup_status_idx" ON "PendingTrialSetup"("status");
