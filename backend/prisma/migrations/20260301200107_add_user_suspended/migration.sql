-- AlterTable
ALTER TABLE "User" ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);
