-- Step 1: Create a "General" category for every server that has no categories
INSERT INTO "ChannelCategory" (id, "serverId", name, position, "createdAt")
SELECT gen_random_uuid(), s.id, 'General', 0, NOW()
FROM "Server" s
WHERE NOT EXISTS (
  SELECT 1 FROM "ChannelCategory" cc WHERE cc."serverId" = s.id
);

-- Step 2: For channels with NULL categoryId, assign to server's lowest-position category
UPDATE "Channel" c
SET "categoryId" = (
  SELECT cc.id FROM "ChannelCategory" cc
  WHERE cc."serverId" = c."serverId"
  ORDER BY cc.position ASC, cc."createdAt" ASC
  LIMIT 1
)
WHERE c."categoryId" IS NULL;

-- Step 3: Make categoryId non-nullable
ALTER TABLE "Channel" ALTER COLUMN "categoryId" SET NOT NULL;

-- Step 4: Replace SET NULL FK with RESTRICT
ALTER TABLE "Channel" DROP CONSTRAINT IF EXISTS "Channel_categoryId_fkey";
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ChannelCategory"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
