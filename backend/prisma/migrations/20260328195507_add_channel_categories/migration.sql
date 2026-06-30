-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChannelCategory" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelCategory_serverId_idx" ON "ChannelCategory"("serverId");

-- CreateIndex
CREATE INDEX "ChannelCategory_serverId_position_idx" ON "ChannelCategory"("serverId", "position");

-- CreateIndex
CREATE INDEX "Channel_categoryId_idx" ON "Channel"("categoryId");

-- CreateIndex
CREATE INDEX "Channel_serverId_position_idx" ON "Channel"("serverId", "position");

-- AddForeignKey
ALTER TABLE "ChannelCategory" ADD CONSTRAINT "ChannelCategory_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ChannelCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill channel positions based on createdAt order
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "serverId" ORDER BY "createdAt" ASC) - 1 AS pos
  FROM "Channel"
)
UPDATE "Channel" SET position = ranked.pos FROM ranked WHERE "Channel".id = ranked.id;
