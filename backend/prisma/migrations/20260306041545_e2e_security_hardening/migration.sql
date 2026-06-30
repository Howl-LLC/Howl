-- CreateTable
CREATE TABLE "KeyBundleFetch" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyBundleFetch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingGroupExchange" (
    "id" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingGroupExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyBundleFetch_targetId_idx" ON "KeyBundleFetch"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "KeyBundleFetch_requesterId_targetId_key" ON "KeyBundleFetch"("requesterId", "targetId");

-- CreateIndex
CREATE INDEX "PendingGroupExchange_recipientId_idx" ON "PendingGroupExchange"("recipientId");

-- CreateIndex
CREATE INDEX "PendingGroupExchange_createdAt_idx" ON "PendingGroupExchange"("createdAt");
