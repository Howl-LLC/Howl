-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN "timeoutUntil" TIMESTAMP(3),
ADD COLUMN "timeoutReason" TEXT,
ADD COLUMN "timedOutById" TEXT;
