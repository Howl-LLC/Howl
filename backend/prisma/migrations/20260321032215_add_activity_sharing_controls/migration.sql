-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN     "shareActivity" BOOLEAN;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activityShareScope" TEXT NOT NULL DEFAULT 'everyone',
ADD COLUMN     "activitySharingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "activitySourcePriority" TEXT NOT NULL DEFAULT 'steam,detected,custom';
