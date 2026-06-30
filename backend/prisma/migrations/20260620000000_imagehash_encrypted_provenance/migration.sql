-- The `POST /upload?encrypted=true` path stores E2E ciphertext, so the
-- server-side content-safety pipeline (MIME magic-byte, EXIF strip,
-- decompression-bomb, SHA-256/NCMEC, PDQ) cannot inspect the bytes. This
-- column records that provenance so the channel-message send path can enforce
-- that an encrypted blob is only attached where the encryption invariant holds.
--
-- Additive + backward-compatible: a new column with a default (existing rows are
-- all genuine scanned uploads -> false) plus a filename index for the per-send
-- provenance lookup (ImageHash previously had no index on filename).
--
-- Hand-written (like the other MLS migrations in this repo) so `prisma migrate
-- dev` does NOT also DROP the search_vector FTS columns/indexes or rename
-- MemberRole FK constraints, which are managed outside the Prisma schema
-- (see migration 20260408213119_add_search_vectors). Only the additive
-- changes below.

-- AddColumn: provenance flag for encrypted (E2E DM) blobs that skipped scanning.
ALTER TABLE "ImageHash" ADD COLUMN "encrypted" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: filename lookup for the channel attach-time provenance check.
CREATE INDEX "ImageHash_filename_idx" ON "ImageHash"("filename");
