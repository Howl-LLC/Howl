-- AlterTable: add discriminator with default for existing rows
ALTER TABLE "User" ADD COLUMN "discriminator" TEXT NOT NULL DEFAULT '0001';

-- Drop default so new rows must get discriminator explicitly
ALTER TABLE "User" ALTER COLUMN "discriminator" DROP DEFAULT;

-- DropIndex: remove unique on username so (username, discriminator) can be unique
DROP INDEX "User_username_key";

-- CreateIndex: unique on (username, discriminator)
CREATE UNIQUE INDEX "User_username_discriminator_key" ON "User"("username", "discriminator");
