-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaTotpSecret" TEXT;
