-- DropIndex
DROP INDEX IF EXISTS "User_email_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_emailHash_key" ON "User"("emailHash");
