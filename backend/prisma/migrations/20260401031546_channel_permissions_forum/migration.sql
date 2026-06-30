-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "ageRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultLayout" TEXT NOT NULL DEFAULT 'list',
ADD COLUMN     "defaultReaction" TEXT,
ADD COLUMN     "defaultSortOrder" TEXT NOT NULL DEFAULT 'recent_activity',
ADD COLUMN     "hideAfterInactivity" INTEGER,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messageSlowMode" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "postGuidelines" TEXT,
ADD COLUMN     "postSlowMode" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requireTags" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userLimit" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ChannelCategory" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ChannelPermissionOverride" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryPermissionOverride" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumPost" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "imageUrl" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumMessage" (
    "id" TEXT NOT NULL,
    "forumPostId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "attachmentName" TEXT,
    "attachmentContentType" TEXT,
    "attachmentWidth" INTEGER,
    "attachmentHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "ForumMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumMessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumMessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumTag" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumPostTag" (
    "postId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "ForumPostTag_pkey" PRIMARY KEY ("postId","tagId")
);

-- CreateIndex
CREATE INDEX "ChannelPermissionOverride_channelId_idx" ON "ChannelPermissionOverride"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPermissionOverride_channelId_targetType_targetId_key" ON "ChannelPermissionOverride"("channelId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "CategoryPermissionOverride_categoryId_idx" ON "CategoryPermissionOverride"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryPermissionOverride_categoryId_targetType_targetId_key" ON "CategoryPermissionOverride"("categoryId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "ForumPost_channelId_idx" ON "ForumPost"("channelId");

-- CreateIndex
CREATE INDEX "ForumPost_channelId_lastActivityAt_idx" ON "ForumPost"("channelId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "ForumPost_channelId_createdAt_idx" ON "ForumPost"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "ForumPost_authorId_idx" ON "ForumPost"("authorId");

-- CreateIndex
CREATE INDEX "ForumMessage_forumPostId_idx" ON "ForumMessage"("forumPostId");

-- CreateIndex
CREATE INDEX "ForumMessage_forumPostId_createdAt_idx" ON "ForumMessage"("forumPostId", "createdAt");

-- CreateIndex
CREATE INDEX "ForumMessage_authorId_idx" ON "ForumMessage"("authorId");

-- CreateIndex
CREATE INDEX "ForumMessageReaction_messageId_idx" ON "ForumMessageReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ForumMessageReaction_messageId_userId_emoji_key" ON "ForumMessageReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "ForumTag_channelId_idx" ON "ForumTag"("channelId");

-- CreateIndex
CREATE INDEX "ForumTag_channelId_position_idx" ON "ForumTag"("channelId", "position");

-- CreateIndex
CREATE INDEX "ForumPostTag_tagId_idx" ON "ForumPostTag"("tagId");

-- AddForeignKey
ALTER TABLE "ChannelPermissionOverride" ADD CONSTRAINT "ChannelPermissionOverride_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryPermissionOverride" ADD CONSTRAINT "CategoryPermissionOverride_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ChannelCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumMessage" ADD CONSTRAINT "ForumMessage_forumPostId_fkey" FOREIGN KEY ("forumPostId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumMessageReaction" ADD CONSTRAINT "ForumMessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ForumMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumTag" ADD CONSTRAINT "ForumTag_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPostTag" ADD CONSTRAINT "ForumPostTag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPostTag" ADD CONSTRAINT "ForumPostTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "ForumTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
