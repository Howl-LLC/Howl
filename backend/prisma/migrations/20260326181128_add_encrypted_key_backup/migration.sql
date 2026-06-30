-- AlterTable: Add backup fields to User (idempotent for partial-apply recovery)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "backupSalt" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "backupConfigured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "backupConfiguredAt" TIMESTAMP(3);

-- CreateTable: EncryptedKeyBackup
CREATE TABLE IF NOT EXISTS "EncryptedKeyBackup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedBlob" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kdfParams" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EncryptedKeyBackup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EncryptedKeyBackup_userId_key" ON "EncryptedKeyBackup"("userId");

-- AddForeignKey
ALTER TABLE "EncryptedKeyBackup" DROP CONSTRAINT IF EXISTS "EncryptedKeyBackup_userId_fkey";
ALTER TABLE "EncryptedKeyBackup" ADD CONSTRAINT "EncryptedKeyBackup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
