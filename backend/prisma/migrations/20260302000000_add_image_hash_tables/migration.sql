-- CreateTable
CREATE TABLE "ImageHash" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "flagMatch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageHash_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlaggedHash" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "addedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlaggedHash_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImageHash_hash_idx" ON "ImageHash"("hash");
CREATE INDEX "ImageHash_uploaderId_idx" ON "ImageHash"("uploaderId");
CREATE INDEX "ImageHash_flagMatch_idx" ON "ImageHash"("flagMatch");
CREATE INDEX "ImageHash_createdAt_idx" ON "ImageHash"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FlaggedHash_hash_key" ON "FlaggedHash"("hash");
CREATE INDEX "FlaggedHash_reason_idx" ON "FlaggedHash"("reason");
