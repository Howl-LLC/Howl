-- Delete duplicate Session rows, keeping the most recently active one per tokenHash
DELETE FROM "Session" s
USING (
  SELECT "tokenHash", MAX("lastActiveAt") AS keep_at
  FROM "Session"
  GROUP BY "tokenHash"
  HAVING COUNT(*) > 1
) dups
WHERE s."tokenHash" = dups."tokenHash"
  AND s."lastActiveAt" < dups.keep_at;

-- Handle exact ties (same tokenHash AND same lastActiveAt): keep only the row with the smallest id
DELETE FROM "Session" a
USING "Session" b
WHERE a."tokenHash" = b."tokenHash"
  AND a."id" > b."id";

-- Same dedup for AdminSession
DELETE FROM "AdminSession" s
USING (
  SELECT "tokenHash", MAX("lastActiveAt") AS keep_at
  FROM "AdminSession"
  GROUP BY "tokenHash"
  HAVING COUNT(*) > 1
) dups
WHERE s."tokenHash" = dups."tokenHash"
  AND s."lastActiveAt" < dups.keep_at;

DELETE FROM "AdminSession" a
USING "AdminSession" b
WHERE a."tokenHash" = b."tokenHash"
  AND a."id" > b."id";

-- DropIndex (use IF EXISTS since partial runs may have already dropped/created some)
DROP INDEX IF EXISTS "AdminSession_tokenHash_idx";
DROP INDEX IF EXISTS "Session_tokenHash_idx";
DROP INDEX IF EXISTS "AdminSession_tokenHash_key";
DROP INDEX IF EXISTS "Session_tokenHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
