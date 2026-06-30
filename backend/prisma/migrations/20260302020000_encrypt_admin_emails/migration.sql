-- AlterTable: add emailHash column, make email column store encrypted data.
-- The old plaintext `email` column becomes the encrypted value; lookups use `emailHash`.
ALTER TABLE "AdminUser" ADD COLUMN "emailHash" TEXT;

-- Populate emailHash from the current plaintext email (will be done by the migration script below).
-- For now, just set it to the existing email so the NOT NULL + UNIQUE constraint can be applied.
UPDATE "AdminUser" SET "emailHash" = email WHERE "emailHash" IS NULL;

-- Drop the old unique constraint on email (plaintext) since encrypted values aren't unique-indexable.
ALTER TABLE "AdminUser" DROP CONSTRAINT IF EXISTS "AdminUser_email_key";

-- Make emailHash required and unique.
ALTER TABLE "AdminUser" ALTER COLUMN "emailHash" SET NOT NULL;
CREATE UNIQUE INDEX "AdminUser_emailHash_key" ON "AdminUser"("emailHash");
