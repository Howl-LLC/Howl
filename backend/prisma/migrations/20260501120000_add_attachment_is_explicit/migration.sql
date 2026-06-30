-- Adds `attachmentIsExplicit` boolean to Message and DMMessage. The field is
-- a client-set NSFW marker that lets the recipient apply their per-attachment
-- "show / blur / hide" preference uniformly across Discover, channels, and
-- DMs. Existing rows default to false; older clients that omit the field
-- continue to send messages indistinguishable from non-explicit content (which
-- matches existing behavior).
--
-- DMs are E2EE: the server stores and forwards this flag as plaintext
-- metadata supplied by the client. No content inspection occurs server-side.
--
-- Additive only — backward compatible per docs/PROTOCOL_CHANGES.md.
ALTER TABLE "Message" ADD COLUMN "attachmentIsExplicit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DMMessage" ADD COLUMN "attachmentIsExplicit" BOOLEAN NOT NULL DEFAULT false;
