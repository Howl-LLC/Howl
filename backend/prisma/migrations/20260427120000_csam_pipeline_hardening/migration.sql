-- ─────────────────────────────────────────────────────────────────────────────
-- CSAM pipeline hardening (2026-04-27)
--
-- 1. MessageReport: authorId nullable + Cascade→SetNull, plus snapshot and
--    forensic fields so a CSAM-uploader self-deleting their account does not
--    erase the §2258A(h) preservation chain. Identity is captured at report
--    time and survives the user delete.
-- 2. ImageHash: SHA-256 column for exact-match cross-provider hash sharing
--    alongside the existing PDQ perceptual hash.
-- 3. User: parentalConsentAcknowledged for 13–17 signups.
-- 4. Session: rawIp + userAgent columns. Populated at session create,
--    purged to NULL after 90 days of inactivity by the cleanup worker.
--    The hashed `ip` column is unchanged (still used for new-device detection).
-- 5. FlaggedHashSnapshot: versioned, atomically-swappable hash-list snapshots
--    so we can ingest NCMEC / Thorn / IWF corpora safely. FlaggedHash gains
--    a nullable snapshotId — manual entries stay active (snapshotId=NULL),
--    snapshot entries are active only when their snapshot.isActive is true.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. MessageReport
ALTER TABLE "MessageReport" DROP CONSTRAINT "MessageReport_authorId_fkey";
ALTER TABLE "MessageReport" ALTER COLUMN "authorId" DROP NOT NULL;
ALTER TABLE "MessageReport"
    ADD COLUMN "authorUsernameSnapshot" TEXT,
    ADD COLUMN "authorDiscriminatorSnapshot" TEXT,
    ADD COLUMN "authorEmailHashSnapshot" TEXT,
    ADD COLUMN "authorRegisteredAtSnapshot" TIMESTAMP(3),
    ADD COLUMN "uploaderIp" TEXT,
    ADD COLUMN "uploaderUserAgent" TEXT,
    ADD COLUMN "sha256" TEXT,
    ADD COLUMN "preservedAt" TIMESTAMP(3);
ALTER TABLE "MessageReport"
    ADD CONSTRAINT "MessageReport_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "MessageReport_reason_preservedAt_idx" ON "MessageReport"("reason", "preservedAt");

-- 2. ImageHash
ALTER TABLE "ImageHash" ADD COLUMN "sha256" TEXT;
CREATE INDEX "ImageHash_sha256_idx" ON "ImageHash"("sha256");

-- 3. User
ALTER TABLE "User" ADD COLUMN "parentalConsentAcknowledged" BOOLEAN NOT NULL DEFAULT false;

-- 4. Session
ALTER TABLE "Session" ADD COLUMN "rawIp" TEXT;
ALTER TABLE "Session" ADD COLUMN "userAgent" TEXT;

-- 5. FlaggedHashSnapshot + FlaggedHash.snapshotId
CREATE TABLE "FlaggedHashSnapshot" (
    "id"          TEXT NOT NULL,
    "version"     SERIAL NOT NULL,
    "source"      TEXT NOT NULL,
    "label"       TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT false,
    "hashCount"   INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "abortedAt"   TIMESTAMP(3),
    "notes"       TEXT,

    CONSTRAINT "FlaggedHashSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FlaggedHashSnapshot_version_key" ON "FlaggedHashSnapshot"("version");
CREATE INDEX "FlaggedHashSnapshot_isActive_idx" ON "FlaggedHashSnapshot"("isActive");
CREATE INDEX "FlaggedHashSnapshot_source_createdAt_idx" ON "FlaggedHashSnapshot"("source", "createdAt");

ALTER TABLE "FlaggedHash" ADD COLUMN "snapshotId" TEXT;
ALTER TABLE "FlaggedHash"
    ADD CONSTRAINT "FlaggedHash_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "FlaggedHashSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "FlaggedHash_snapshotId_idx" ON "FlaggedHash"("snapshotId");
