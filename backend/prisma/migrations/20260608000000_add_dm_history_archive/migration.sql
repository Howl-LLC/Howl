-- DmHistoryArchive — server-side opaque sealed DM history.
--
-- NOTE: this migration was hand-trimmed. `prisma migrate dev` also wanted to
-- DROP the `search_vector` FTS columns/indexes on Message/DMMessage and rename
-- MemberRole FK constraints — those are managed outside the Prisma schema
-- (see migration 20260408213119_add_search_vectors) and must NOT be touched.
-- Only the single new DmHistoryArchive table + its indexes/FKs are included.
--
-- Additive only. Each row is one archived DM message, per user: an opaque,
-- client-sealed AES-256-GCM ciphertext (server never reads the plaintext).
-- The (userId, dmChannelId, envelopeHash) unique index gives idempotent upsert
-- and multi-device convergence.

-- CreateTable
CREATE TABLE "DmHistoryArchive" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "envelopeHash" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "messageId" TEXT NOT NULL,
    "msgCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmHistoryArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DmHistoryArchive_userId_dmChannelId_envelopeHash_key" ON "DmHistoryArchive"("userId", "dmChannelId", "envelopeHash");

-- CreateIndex
CREATE INDEX "DmHistoryArchive_userId_dmChannelId_msgCreatedAt_idx" ON "DmHistoryArchive"("userId", "dmChannelId", "msgCreatedAt");

-- CreateIndex
CREATE INDEX "DmHistoryArchive_userId_dmChannelId_messageId_idx" ON "DmHistoryArchive"("userId", "dmChannelId", "messageId");

-- CreateIndex
CREATE INDEX "DmHistoryArchive_userId_idx" ON "DmHistoryArchive"("userId");

-- AddForeignKey
ALTER TABLE "DmHistoryArchive" ADD CONSTRAINT "DmHistoryArchive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmHistoryArchive" ADD CONSTRAINT "DmHistoryArchive_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
