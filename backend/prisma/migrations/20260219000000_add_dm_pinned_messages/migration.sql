-- CreateTable
CREATE TABLE "DMPinnedMessage" (
    "id" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedById" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMPinnedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DMPinnedMessage_dmChannelId_messageId_key" ON "DMPinnedMessage"("dmChannelId", "messageId");

-- CreateIndex
CREATE INDEX "DMPinnedMessage_dmChannelId_idx" ON "DMPinnedMessage"("dmChannelId");

-- AddForeignKey
ALTER TABLE "DMPinnedMessage" ADD CONSTRAINT "DMPinnedMessage_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
