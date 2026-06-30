-- ============================================================
-- Full-text search vectors for Message and DMMessage tables
-- ============================================================

-- ── Message table ──────────────────────────────────────────
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

-- Populate existing rows
UPDATE "Message" SET "search_vector" = to_tsvector('english', coalesce("content", ''))
  WHERE "search_vector" IS NULL;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS "Message_search_vector_idx" ON "Message" USING GIN ("search_vector");

-- Auto-update trigger on INSERT or UPDATE of content
CREATE OR REPLACE FUNCTION message_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."search_vector" := to_tsvector('english', coalesce(NEW."content", ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_search_vector_update ON "Message";
CREATE TRIGGER message_search_vector_update
  BEFORE INSERT OR UPDATE OF "content" ON "Message"
  FOR EACH ROW
  EXECUTE FUNCTION message_search_vector_trigger();

-- ── DMMessage table ────────────────────────────────────────
-- Only indexes non-encrypted messages (contentIv IS NULL)
ALTER TABLE "DMMessage" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

-- Populate existing non-encrypted rows
UPDATE "DMMessage" SET "search_vector" = to_tsvector('english', coalesce("content", ''))
  WHERE "contentIv" IS NULL AND "search_vector" IS NULL;

-- GIN index
CREATE INDEX IF NOT EXISTS "DMMessage_search_vector_idx" ON "DMMessage" USING GIN ("search_vector");

-- Auto-update trigger — only indexes non-encrypted messages
CREATE OR REPLACE FUNCTION dm_message_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW."contentIv" IS NULL THEN
    NEW."search_vector" := to_tsvector('english', coalesce(NEW."content", ''));
  ELSE
    NEW."search_vector" := NULL;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dm_message_search_vector_update ON "DMMessage";
CREATE TRIGGER dm_message_search_vector_update
  BEFORE INSERT OR UPDATE OF "content" ON "DMMessage"
  FOR EACH ROW
  EXECUTE FUNCTION dm_message_search_vector_trigger();
