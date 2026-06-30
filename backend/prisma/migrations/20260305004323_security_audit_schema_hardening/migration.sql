-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN');

-- AlterTable: convert User.role from text to enum
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateIndex: unique constraint on User.email
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AdminUser_email_key already exists from 20260228035028_add_admin_tables
