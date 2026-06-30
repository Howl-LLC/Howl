-- Upload per-resource ACL: the serve route GET /api/uploads/:filename resolves a
-- file's owning channel/DM by looking up the message/post row whose attachment
-- column references the file (incl. thumb_/frame_ derivatives, matched by the
-- file's uuid stem via a left-anchored LIKE) across every attachment-bearing
-- surface: channel messages, DM messages, thread messages, forum messages, and
-- forum-post cover images. These indexes make that a hot-path range lookup
-- instead of a full table scan. text_pattern_ops is required so
-- `attachmentUrl LIKE '/api/uploads/<uuid>.%'` uses the index under the default
-- collation.
--
-- Additive (index-only), backward-compatible, no backfill.
--
-- Hand-written (like the other security migrations in this repo) so `prisma
-- migrate dev` does NOT also DROP the search_vector FTS columns/indexes on
-- Message/DMMessage or rename MemberRole FK constraints, which are managed
-- outside the Prisma schema (see migration 20260408213119_add_search_vectors).

-- CreateIndex
CREATE INDEX "Message_attachmentUrl_idx" ON "Message" ("attachmentUrl" text_pattern_ops);

-- CreateIndex
CREATE INDEX "DMMessage_attachmentUrl_idx" ON "DMMessage" ("attachmentUrl" text_pattern_ops);

-- CreateIndex
CREATE INDEX "ThreadMessage_attachmentUrl_idx" ON "ThreadMessage" ("attachmentUrl" text_pattern_ops);

-- CreateIndex
CREATE INDEX "ForumMessage_attachmentUrl_idx" ON "ForumMessage" ("attachmentUrl" text_pattern_ops);

-- CreateIndex
CREATE INDEX "ForumPost_imageUrl_idx" ON "ForumPost" ("imageUrl" text_pattern_ops);
