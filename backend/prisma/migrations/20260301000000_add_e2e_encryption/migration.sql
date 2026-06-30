-- CreateTable: UserKeyBundle for E2E encryption key management
CREATE TABLE "UserKeyBundle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "identityPubKey" TEXT NOT NULL,
    "signedPreKey" TEXT NOT NULL,
    "preKeySignature" TEXT NOT NULL,
    "oneTimePreKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserKeyBundle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserKeyBundle_userId_key" ON "UserKeyBundle"("userId");

-- AddForeignKey
ALTER TABLE "UserKeyBundle" ADD CONSTRAINT "UserKeyBundle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add encrypted column to DMChannel (default true for new channels)
ALTER TABLE "DMChannel" ADD COLUMN "encrypted" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable: MessageReport for user/admin content moderation
CREATE TABLE "MessageReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "messageType" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "channelId" TEXT,
    "dmChannelId" TEXT,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "actionTaken" TEXT,
    "ncmecReportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageReport_status_idx" ON "MessageReport"("status");
CREATE INDEX "MessageReport_reporterId_idx" ON "MessageReport"("reporterId");
CREATE INDEX "MessageReport_authorId_idx" ON "MessageReport"("authorId");
CREATE INDEX "MessageReport_createdAt_idx" ON "MessageReport"("createdAt");
CREATE INDEX "MessageReport_messageType_status_idx" ON "MessageReport"("messageType", "status");
