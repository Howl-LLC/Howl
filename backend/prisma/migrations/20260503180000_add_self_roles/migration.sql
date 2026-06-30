-- Self Roles — schema additions
-- One picker per server (v1) — `RolePickerChannel.serverId` is unique. Backend
-- channel-create rejects with 409 when the constraint would be violated.

-- AlterTable
ALTER TABLE "ServerRole" ADD COLUMN "selfAssignable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RolePickerChannel" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "heroTitle" VARCHAR(80),
    "heroDescription" VARCHAR(280),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolePickerChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePickerCategory" (
    "id" TEXT NOT NULL,
    "pickerId" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "pickMode" TEXT NOT NULL DEFAULT 'multi',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePickerCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePickerEntry" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "emoji" VARCHAR(8),
    "description" VARCHAR(200),
    "requirements" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePickerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleClaimRequest" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pickerEntryId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "applicantMessage" VARCHAR(500),
    "decidedById" TEXT,
    "decisionNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "RoleClaimRequest_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "RolePickerChannel_channelId_key" ON "RolePickerChannel"("channelId");
CREATE UNIQUE INDEX "RolePickerChannel_serverId_key" ON "RolePickerChannel"("serverId");
CREATE INDEX "RolePickerCategory_pickerId_idx" ON "RolePickerCategory"("pickerId");
CREATE UNIQUE INDEX "RolePickerCategory_pickerId_position_key" ON "RolePickerCategory"("pickerId", "position");
CREATE INDEX "RolePickerEntry_categoryId_idx" ON "RolePickerEntry"("categoryId");
CREATE INDEX "RolePickerEntry_roleId_idx" ON "RolePickerEntry"("roleId");
CREATE UNIQUE INDEX "RolePickerEntry_categoryId_roleId_key" ON "RolePickerEntry"("categoryId", "roleId");
CREATE INDEX "RoleClaimRequest_serverId_status_createdAt_idx" ON "RoleClaimRequest"("serverId", "status", "createdAt");
CREATE INDEX "RoleClaimRequest_userId_idx" ON "RoleClaimRequest"("userId");

-- Partial unique: a user can have at most one pending request per picker entry.
-- Prisma can't express filtered uniques in @@unique, so we add it raw.
CREATE UNIQUE INDEX "RoleClaimRequest_pending_unique"
  ON "RoleClaimRequest" ("serverId", "userId", "pickerEntryId")
  WHERE "status" = 'pending';

-- Foreign keys
ALTER TABLE "RolePickerChannel" ADD CONSTRAINT "RolePickerChannel_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePickerChannel" ADD CONSTRAINT "RolePickerChannel_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePickerCategory" ADD CONSTRAINT "RolePickerCategory_pickerId_fkey"
    FOREIGN KEY ("pickerId") REFERENCES "RolePickerChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePickerEntry" ADD CONSTRAINT "RolePickerEntry_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "RolePickerCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePickerEntry" ADD CONSTRAINT "RolePickerEntry_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "ServerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleClaimRequest" ADD CONSTRAINT "RoleClaimRequest_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleClaimRequest" ADD CONSTRAINT "RoleClaimRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleClaimRequest" ADD CONSTRAINT "RoleClaimRequest_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoleClaimRequest" ADD CONSTRAINT "RoleClaimRequest_pickerEntryId_fkey"
    FOREIGN KEY ("pickerEntryId") REFERENCES "RolePickerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
