-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activityBio" TEXT,
ADD COLUMN     "shareActivityBio" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "activitySourcePriority" SET DEFAULT 'steam,detected,custom,bio';
