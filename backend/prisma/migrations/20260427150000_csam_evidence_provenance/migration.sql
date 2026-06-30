-- ─────────────────────────────────────────────────────────────────────────────
-- CSAM evidence provenance (2026-04-27, follow-up to 20260427120000)
--
-- Two follow-up additions to MessageReport so the report row is self-describing
-- about the *quality* of the evidence captured on it:
--
--   - intendedSource / intendedSourceId — at upload-block time we know which
--     channel/DM/server-icon/avatar slot the user was attempting to attach to.
--     That intended-target context is investigatively useful (server-with-a-
--     -problem signal, NCMEC routing) and was already on ImageHash but did
--     not flow onto the auto-flag MessageReport. Now it does.
--
--   - evidenceSource / evidenceCapturedAt — distinguishes which codepath
--     populated uploaderIp/uploaderUserAgent. 'upload-block' is the offending
--     IP/UA captured synchronously at the upload request. 'action-time-lookup'
--     is a best-effort snapshot taken when an admin promotes a user-reported
--     CSAM to actioned, looking up the session active around the message's
--     timestamp. 'action-time-unavailable' marks the case where the 90-day
--     Session retention window had already expired so uploaderIp/UA are null;
--     the admin UI surfaces this so moderators know they're filing with
--     degraded evidence.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "MessageReport"
    ADD COLUMN "intendedSource"     TEXT,
    ADD COLUMN "intendedSourceId"   TEXT,
    ADD COLUMN "evidenceSource"     TEXT,
    ADD COLUMN "evidenceCapturedAt" TIMESTAMP(3);
