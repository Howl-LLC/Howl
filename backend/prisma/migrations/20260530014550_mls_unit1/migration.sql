-- MLS Delivery + Authentication Service models.
--
-- NOTE: this migration was hand-trimmed. `prisma migrate dev` also wanted to
-- DROP the `search_vector` FTS columns/indexes on Message/DMMessage and rename
-- MemberRole FK constraints — those are managed outside the Prisma schema
-- (see migration 20260408213119_add_search_vectors) and must NOT be touched.
-- Only the 4 new MLS tables + their indexes/FKs are included below.

-- CreateTable
CREATE TABLE "MlsGroup" (
    "id" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'saved',
    "cipherSuite" INTEGER NOT NULL DEFAULT 1,
    "currentEpoch" BIGINT NOT NULL DEFAULT 0,
    "groupInfo" BYTEA,
    "groupInfoEpoch" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlsGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlsCommit" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL,
    "commitData" BYTEA NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "senderLeaf" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsCommit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlsKeyPackage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyPackageRef" TEXT NOT NULL,
    "keyPackage" BYTEA NOT NULL,
    "isLastResort" BOOLEAN NOT NULL DEFAULT false,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsKeyPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlsWelcome" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL,
    "welcomeData" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsWelcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MlsGroup_dmChannelId_tier_key" ON "MlsGroup"("dmChannelId", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "MlsCommit_groupId_epoch_key" ON "MlsCommit"("groupId", "epoch");

-- CreateIndex
CREATE UNIQUE INDEX "MlsCommit_groupId_idempotencyKey_key" ON "MlsCommit"("groupId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MlsKeyPackage_keyPackageRef_key" ON "MlsKeyPackage"("keyPackageRef");

-- CreateIndex
CREATE INDEX "MlsKeyPackage_userId_deviceId_consumedAt_idx" ON "MlsKeyPackage"("userId", "deviceId", "consumedAt");

-- CreateIndex
CREATE INDEX "MlsKeyPackage_notAfter_idx" ON "MlsKeyPackage"("notAfter");

-- CreateIndex
CREATE INDEX "MlsWelcome_recipientId_idx" ON "MlsWelcome"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "MlsWelcome_recipientId_groupId_epoch_key" ON "MlsWelcome"("recipientId", "groupId", "epoch");

-- AddForeignKey
ALTER TABLE "MlsGroup" ADD CONSTRAINT "MlsGroup_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlsCommit" ADD CONSTRAINT "MlsCommit_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MlsGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlsKeyPackage" ADD CONSTRAINT "MlsKeyPackage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlsWelcome" ADD CONSTRAINT "MlsWelcome_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
