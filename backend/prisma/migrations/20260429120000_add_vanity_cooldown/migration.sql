-- AlterTable: track the last successful vanity-URL claim so we can enforce
-- a 30-day cooldown between changes. NULL for existing rows by design — the
-- next change after deploy is allowed; subsequent changes are gated.
ALTER TABLE "Server" ADD COLUMN "vanityLastClaimedAt" TIMESTAMP(3);
