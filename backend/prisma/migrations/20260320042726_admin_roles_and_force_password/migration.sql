-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "forcePasswordChange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'admin';

-- Promote the initial admin account to owner. Replace 'admin' with your
-- bootstrap admin username (see `npm run create-admin`).
UPDATE "AdminUser" SET "role" = 'owner' WHERE "username" = 'admin';
