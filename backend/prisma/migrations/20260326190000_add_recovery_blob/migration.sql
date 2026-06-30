-- AlterTable: Add recovery blob fields to EncryptedKeyBackup
ALTER TABLE "EncryptedKeyBackup" ADD COLUMN "recoveryBlob" TEXT;
ALTER TABLE "EncryptedKeyBackup" ADD COLUMN "recoveryNonce" TEXT;
