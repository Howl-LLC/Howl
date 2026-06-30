-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaRecoveryCodes" JSONB,
ADD COLUMN     "passwordResetCode" TEXT,
ADD COLUMN     "passwordResetExpiry" TIMESTAMP(3);
