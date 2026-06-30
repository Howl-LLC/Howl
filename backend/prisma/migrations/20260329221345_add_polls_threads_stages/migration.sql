-- CreateTable
CREATE TABLE "Poll" (
    "id" TEXT NOT NULL,
    "channelId" TEXT,
    "dmChannelId" TEXT,
    "serverId" TEXT,
    "authorId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "duration" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "parentMessageId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "autoArchive" BOOLEAN NOT NULL DEFAULT true,
    "autoArchiveDuration" INTEGER NOT NULL DEFAULT 1440,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'message',
    "systemPayload" JSONB,
    "replyToMessageId" TEXT,
    "attachmentUrl" TEXT,
    "attachmentName" TEXT,
    "attachmentContentType" TEXT,
    "attachmentWidth" INTEGER,
    "attachmentHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "ThreadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadMessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadMessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageSession" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "topic" TEXT,
    "maxSpeakers" INTEGER NOT NULL DEFAULT 10,
    "textChatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "StageSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Poll_channelId_idx" ON "Poll"("channelId");

-- CreateIndex
CREATE INDEX "Poll_dmChannelId_idx" ON "Poll"("dmChannelId");

-- CreateIndex
CREATE INDEX "Poll_serverId_idx" ON "Poll"("serverId");

-- CreateIndex
CREATE INDEX "Poll_authorId_idx" ON "Poll"("authorId");

-- CreateIndex
CREATE INDEX "Poll_expiresAt_idx" ON "Poll"("expiresAt");

-- CreateIndex
CREATE INDEX "PollOption_pollId_idx" ON "PollOption"("pollId");

-- CreateIndex
CREATE INDEX "PollVote_pollId_idx" ON "PollVote"("pollId");

-- CreateIndex
CREATE INDEX "PollVote_userId_idx" ON "PollVote"("userId");

-- CreateIndex
CREATE INDEX "PollVote_optionId_idx" ON "PollVote"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "PollVote_pollId_optionId_userId_key" ON "PollVote"("pollId", "optionId", "userId");

-- CreateIndex
CREATE INDEX "Thread_channelId_idx" ON "Thread"("channelId");

-- CreateIndex
CREATE INDEX "Thread_serverId_idx" ON "Thread"("serverId");

-- CreateIndex
CREATE INDEX "Thread_parentMessageId_idx" ON "Thread"("parentMessageId");

-- CreateIndex
CREATE INDEX "Thread_archived_idx" ON "Thread"("archived");

-- CreateIndex
CREATE INDEX "Thread_lastActivityAt_idx" ON "Thread"("lastActivityAt");

-- CreateIndex
CREATE INDEX "Thread_channelId_archived_idx" ON "Thread"("channelId", "archived");

-- CreateIndex
CREATE INDEX "ThreadMessage_threadId_idx" ON "ThreadMessage"("threadId");

-- CreateIndex
CREATE INDEX "ThreadMessage_authorId_idx" ON "ThreadMessage"("authorId");

-- CreateIndex
CREATE INDEX "ThreadMessage_createdAt_idx" ON "ThreadMessage"("createdAt");

-- CreateIndex
CREATE INDEX "ThreadMessage_threadId_createdAt_idx" ON "ThreadMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ThreadMessage_threadId_id_idx" ON "ThreadMessage"("threadId", "id");

-- CreateIndex
CREATE INDEX "ThreadMessage_replyToMessageId_idx" ON "ThreadMessage"("replyToMessageId");

-- CreateIndex
CREATE INDEX "ThreadMessageReaction_messageId_idx" ON "ThreadMessageReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadMessageReaction_messageId_userId_emoji_key" ON "ThreadMessageReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "StageSession_channelId_idx" ON "StageSession"("channelId");

-- CreateIndex
CREATE INDEX "StageSession_serverId_idx" ON "StageSession"("serverId");

-- CreateIndex
CREATE INDEX "StageSession_channelId_endedAt_idx" ON "StageSession"("channelId", "endedAt");

-- AddForeignKey
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadMessage" ADD CONSTRAINT "ThreadMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "ThreadMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadMessage" ADD CONSTRAINT "ThreadMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadMessageReaction" ADD CONSTRAINT "ThreadMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ThreadMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageSession" ADD CONSTRAINT "StageSession_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageSession" ADD CONSTRAINT "StageSession_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
