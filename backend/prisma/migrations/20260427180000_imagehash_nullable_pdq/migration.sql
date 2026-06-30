-- ─────────────────────────────────────────────────────────────────────────────
-- ImageHash.hash → nullable (2026-04-27, follow-up to 20260427150000)
--
-- Non-image uploads (video, audio, PDF, zip) don't have a perceptual hash
-- but we still want to record their SHA-256 so NCMEC reports for user-
-- reported video/audio CSAM can include cross-provider exact-match hashes.
-- Adding a row to ImageHash with hash=NULL, sha256=set, filename=set is the
-- cleanest place to store this without a parallel "MediaHash" table; the
-- PDQ-matching code paths simply filter `hash IS NOT NULL` to skip
-- non-PDQable rows.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "ImageHash" ALTER COLUMN "hash" DROP NOT NULL;
