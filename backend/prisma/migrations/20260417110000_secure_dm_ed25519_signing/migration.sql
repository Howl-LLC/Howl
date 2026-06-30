-- Add Ed25519 signing key to SecureKeyBundle and signature
-- columns to PendingKeyDelivery. Existing rows get NULL; clients lazily
-- generate + upload a signing key on next unlock.

-- AlterTable
ALTER TABLE "SecureKeyBundle" ADD COLUMN "signingPublicKey" TEXT;

-- AlterTable
ALTER TABLE "PendingKeyDelivery" ADD COLUMN "senderId" TEXT;
ALTER TABLE "PendingKeyDelivery" ADD COLUMN "signedPayloadV" INTEGER;
ALTER TABLE "PendingKeyDelivery" ADD COLUMN "signature" TEXT;
