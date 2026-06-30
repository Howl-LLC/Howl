-- AlterTable
ALTER TABLE "User" ADD COLUMN     "legalConsentVersion" TEXT,
ADD COLUMN     "needsOnboarding" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "privacyPolicyAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "tosAcceptedAt" TIMESTAMP(3);
