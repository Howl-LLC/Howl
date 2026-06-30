-- Move-to-Private: server-side high-water mark for the DM history-archive
-- archiveKey rotation. A POST whose keyVersion is below this floor is skipped,
-- closing the stale-sibling-tab re-upload race after a bulk DELETE bumps it.

-- AlterTable
ALTER TABLE "SecureKeyBundle" ADD COLUMN "minArchiveKeyVersion" INTEGER NOT NULL DEFAULT 1;
