-- Make categoryId nullable again
ALTER TABLE "Channel" ALTER COLUMN "categoryId" DROP NOT NULL;

-- Replace RESTRICT FK with SET NULL
ALTER TABLE "Channel" DROP CONSTRAINT IF EXISTS "Channel_categoryId_fkey";
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ChannelCategory"(id)
  ON DELETE SET NULL ON UPDATE CASCADE;
