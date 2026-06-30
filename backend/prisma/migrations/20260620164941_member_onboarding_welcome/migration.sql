-- Member onboarding + welcome-channel + auto-roles schema.
--   * ServerSettings.onboardingEnabled / welcomeChannelId (+ FK to Channel,
--     ON DELETE SET NULL)
--   * ServerMember.onboardingCompletedAt
--   * RolePickerCategory.required
--   * ServerAutoRole join table (Server <-> ServerRole, composite PK, both FKs
--     ON DELETE CASCADE)
--
-- NOTE: this migration was hand-trimmed. `prisma migrate diff` against the live
-- DB also wanted to DROP the `search_vector` FTS columns/indexes on
-- Message/DMMessage and rename MemberRole FK constraints — those are managed
-- outside the Prisma schema (see migration 20260408213119_add_search_vectors)
-- and must NOT be touched. When generating future migrations, use
-- `--create-only` (or hand-author like this) and strip that drift.

-- AlterTable
ALTER TABLE "RolePickerCategory" ADD COLUMN     "required" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ServerSettings" ADD COLUMN     "onboardingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "welcomeChannelId" TEXT;

-- CreateTable
CREATE TABLE "ServerAutoRole" (
    "serverId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "ServerAutoRole_pkey" PRIMARY KEY ("serverId","roleId")
);

-- CreateIndex
CREATE INDEX "ServerAutoRole_serverId_idx" ON "ServerAutoRole"("serverId");

-- AddForeignKey
ALTER TABLE "ServerSettings" ADD CONSTRAINT "ServerSettings_welcomeChannelId_fkey" FOREIGN KEY ("welcomeChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerAutoRole" ADD CONSTRAINT "ServerAutoRole_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerAutoRole" ADD CONSTRAINT "ServerAutoRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "ServerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
