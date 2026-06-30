-- Adds a moderator-only note to ServerApplication, distinct from the
-- existing applicant-facing `decisionNote`. Nullable, additive — historical
-- rows are unaffected and continue to read as NULL.
ALTER TABLE "ServerApplication" ADD COLUMN "internalNote" TEXT;
