-- Legacy E2EE teardown.
-- Drops the X25519 dead-drop table, the mutual-verification table, and the
-- legacy report-verification columns.

DROP TABLE IF EXISTS "PendingKeyDelivery";
DROP TABLE IF EXISTS "DmVerification";

ALTER TABLE "MessageReport" DROP COLUMN IF EXISTS "channelKey";
ALTER TABLE "MessageReport" DROP COLUMN IF EXISTS "verificationState";
