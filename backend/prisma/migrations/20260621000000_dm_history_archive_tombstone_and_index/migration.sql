-- Write-once delete-for-everyone tombstone table +
-- a per-user oldest-first eviction scan index on DmHistoryArchive.

-- CreateTable
CREATE TABLE "DmHistoryArchiveTombstone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmHistoryArchiveTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DmHistoryArchiveTombstone_userId_dmChannelId_messageId_key" ON "DmHistoryArchiveTombstone"("userId", "dmChannelId", "messageId");

-- CreateIndex
CREATE INDEX "DmHistoryArchiveTombstone_userId_dmChannelId_idx" ON "DmHistoryArchiveTombstone"("userId", "dmChannelId");

-- CreateIndex
CREATE INDEX "DmHistoryArchive_userId_msgCreatedAt_id_idx" ON "DmHistoryArchive"("userId", "msgCreatedAt", "id");

-- AddForeignKey
ALTER TABLE "DmHistoryArchiveTombstone" ADD CONSTRAINT "DmHistoryArchiveTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmHistoryArchiveTombstone" ADD CONSTRAINT "DmHistoryArchiveTombstone_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
