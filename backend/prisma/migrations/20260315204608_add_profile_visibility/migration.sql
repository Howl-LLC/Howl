-- AlterTable
ALTER TABLE "User" ADD COLUMN     "showBadges" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showJoinDate" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showOnlineStatus" TEXT NOT NULL DEFAULT 'everyone';
