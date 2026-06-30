-- CreateIndex
CREATE INDEX "Message_authorId_channelId_idx" ON "Message"("authorId", "channelId");
