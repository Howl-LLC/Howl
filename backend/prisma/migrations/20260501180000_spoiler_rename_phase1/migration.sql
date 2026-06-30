-- Additive half of the spoiler rename + age-gate change.
--
-- Per docs/PROTOCOL_CHANGES.md rule 4 + rule 7, this is the additive
-- half of a two-phase rename. New columns sit alongside the old ones for
-- ≥60 days; a follow-up PR with `compat-break-approved` drops the old
-- ones and bumps protocolVersion.
--
-- DMs are E2EE: spoiler / alt fields are plaintext metadata the client
-- volunteers. Server stores and forwards only — no content inspection.

-- ─── New per-attachment fields ──────────────────────────────────────────
-- attachmentIsSpoiler is the new source-of-truth name for what was
-- previously called attachmentIsExplicit. attachmentAlt is new alt text.
ALTER TABLE "Message"   ADD COLUMN "attachmentIsSpoiler" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message"   ADD COLUMN "attachmentAlt" TEXT;
ALTER TABLE "DMMessage" ADD COLUMN "attachmentIsSpoiler" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DMMessage" ADD COLUMN "attachmentAlt" TEXT;

-- Backfill the new spoiler flag from the legacy explicit flag so existing
-- content keeps the same visual gating after deploy.
UPDATE "Message"   SET "attachmentIsSpoiler" = "attachmentIsExplicit" WHERE "attachmentIsExplicit" = true;
UPDATE "DMMessage" SET "attachmentIsSpoiler" = "attachmentIsExplicit" WHERE "attachmentIsExplicit" = true;

-- ─── Per-channel age-gate acceptance ───────────────────────────────────
-- Server-side persistence of "user has accepted the 18+ gate for this
-- channel". Cascades naturally when the ServerMember row is deleted
-- (leave / kick / ban). Channel-delete cleanup handled in route code.
ALTER TABLE "ServerMember"
  ADD COLUMN "acceptedAgeRestrictedChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ─── Migrate server-level NSFW + age-gate to per-channel age-restriction ──
-- The new system uses Channel.ageRestricted as the single NSFW concept.
-- For any server flagged either via Server.nsfwLevel='mature' or
-- ServerSettings.ageRestricted=true, mark every text/voice/forum channel
-- in that server as ageRestricted=true so the existing 18+ enforcement
-- is preserved at the channel layer.
UPDATE "Channel" c
SET "ageRestricted" = true
WHERE c."serverId" IN (
  SELECT s.id FROM "Server" s WHERE s."nsfwLevel" = 'mature'
  UNION
  SELECT ss."serverId" FROM "ServerSettings" ss WHERE ss."ageRestricted" = true
);

-- Force-disable Discovery for any server that now has age-restricted channels.
-- Defense in depth — there shouldn't be any pre-existing
-- discoveryEnabled=true servers with nsfwLevel='mature' (the discovery
-- query already filtered them) but if any slipped through, this clears
-- them now that the new mutual-exclusion rule applies.
UPDATE "ServerSettings" ss
SET "discoveryEnabled" = false
WHERE ss."serverId" IN (
  SELECT DISTINCT c."serverId" FROM "Channel" c WHERE c."ageRestricted" = true
);
