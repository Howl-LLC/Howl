-- AlterTable
ALTER TABLE "DMParticipant" ADD COLUMN     "mentionCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT,
    "channelId" TEXT,
    "threadId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "metadata" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelReadState" (
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mentionCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ChannelReadState_pkey" PRIMARY KEY ("userId","channelId")
);

-- CreateTable
CREATE TABLE "ThreadReadState" (
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mentionCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ThreadReadState_pkey" PRIMARY KEY ("userId","threadId")
);

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_serverId_read_idx" ON "Notification"("userId", "serverId", "read");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_serverId_idx" ON "Notification"("serverId");

-- CreateIndex
CREATE INDEX "ChannelReadState_channelId_idx" ON "ChannelReadState"("channelId");

-- CreateIndex
CREATE INDEX "ChannelReadState_userId_idx" ON "ChannelReadState"("userId");

-- CreateIndex
CREATE INDEX "ThreadReadState_threadId_idx" ON "ThreadReadState"("threadId");

-- CreateIndex
CREATE INDEX "ThreadReadState_userId_idx" ON "ThreadReadState"("userId");
