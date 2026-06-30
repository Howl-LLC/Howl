-- Refund hardening: saga columns, charge uniqueness, cross-account anti-bypass.

-- Refund: drop redundant non-unique index on stripeChargeId before adding the unique constraint.
DROP INDEX IF EXISTS "Refund_stripeChargeId_idx";

-- Refund: add unique constraint on stripeChargeId (DB-level guard against double-refund).
-- If existing data has duplicates this will fail loudly; intentionally surface that.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_stripeChargeId_key" UNIQUE ("stripeChargeId");

-- Refund: saga columns + payment-method tracking.
ALTER TABLE "Refund" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE "Refund" ADD COLUMN "paymentMethodFingerprint" TEXT;
ALTER TABLE "Refund" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill completedAt for pre-existing rows so they're indistinguishable from new completed rows.
UPDATE "Refund" SET "completedAt" = "createdAt" WHERE "completedAt" IS NULL;

-- Index status for the webhook reconciler that scans for stale 'pending' rows.
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- RefundUsage: lifetime per-category record that survives User deletion (no FK).
CREATE TABLE "RefundUsage" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "emailHash" TEXT,
    "stripeCustomerId" TEXT,
    "paymentMethodFingerprint" TEXT,
    "refundedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refundId" TEXT,
    CONSTRAINT "RefundUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RefundUsage_emailHash_type_idx" ON "RefundUsage"("emailHash", "type");
CREATE INDEX "RefundUsage_stripeCustomerId_type_idx" ON "RefundUsage"("stripeCustomerId", "type");
CREATE INDEX "RefundUsage_paymentMethodFingerprint_type_idx" ON "RefundUsage"("paymentMethodFingerprint", "type");

-- Backfill RefundUsage from existing Refund rows so the cross-account check
-- catches account-delete bypasses for users who already used a refund.
INSERT INTO "RefundUsage" ("id", "type", "stripeCustomerId", "refundedAt", "refundId")
SELECT
    gen_random_uuid()::TEXT,
    r."type",
    u."stripeCustomerId",
    r."createdAt",
    r."id"
FROM "Refund" r
JOIN "User" u ON u."id" = r."userId"
WHERE u."stripeCustomerId" IS NOT NULL;
