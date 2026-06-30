-- AlterTable
ALTER TABLE "StageSession" ADD COLUMN     "invitedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "invitedSpeakerUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
