-- CreateTable
CREATE TABLE "ChannelPinnedMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedById" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelPinnedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPinnedMessage_channelId_messageId_key" ON "ChannelPinnedMessage"("channelId", "messageId");

-- CreateIndex
CREATE INDEX "ChannelPinnedMessage_channelId_idx" ON "ChannelPinnedMessage"("channelId");

-- AddForeignKey
ALTER TABLE "ChannelPinnedMessage" ADD CONSTRAINT "ChannelPinnedMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
