-- AlterTable
ALTER TABLE "SecureKeyBundle" ADD COLUMN     "passwordDerived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serverEscrowBlob" TEXT;
