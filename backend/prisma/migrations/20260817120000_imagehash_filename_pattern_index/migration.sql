-- Upload per-resource ACL, provenance binding. resolveUploadOwner
-- now scopes a file's owning channel/DM to the rows authored by its UPLOADER, and
-- resolves that uploader from ImageHash via a left-anchored `filename LIKE
-- '<uuid-stem>%'` (the stored name is `<stem>` or `<stem>.<ext>`; thumb_/frame_
-- derivatives share the stem). The existing ImageHash_filename_idx is a
-- default-collation btree: it serves the equality probe in
-- services/uploadProvenance.ts but a prefix LIKE cannot use it, which would make
-- every gated image serve a sequential scan of ImageHash. text_pattern_ops fixes
-- that, exactly as 20260625100000_attachment_url_indexes did for the
-- attachmentUrl/imageUrl columns.
--
-- Additive (index-only), backward-compatible, no backfill.
--
-- Hand-written (like the other security migrations in this repo) so `prisma
-- migrate dev` does NOT also DROP the search_vector FTS columns/indexes on
-- Message/DMMessage or rename MemberRole FK constraints, which are managed
-- outside the Prisma schema (see migration 20260408213119_add_search_vectors).

-- CreateIndex
CREATE INDEX "ImageHash_filename_pattern_idx" ON "ImageHash" ("filename" text_pattern_ops);
