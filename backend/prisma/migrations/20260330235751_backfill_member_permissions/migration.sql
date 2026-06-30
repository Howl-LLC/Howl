-- Backfill missing permissions on existing "Member" server roles.
-- Uses jsonb operators to only add keys that don't already exist.
-- If an admin explicitly set a permission to false, it is NOT overwritten.

UPDATE "ServerRole"
SET "permissions" = COALESCE("permissions", '{}'::jsonb) || (
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each('{"createPolls": true, "createThreads": true, "sendMessagesInThreads": true, "requestToSpeak": true}'::jsonb) AS t(key, value)
  WHERE NOT COALESCE("ServerRole"."permissions", '{}'::jsonb) ? key
)
WHERE "name" = 'Member'
  AND NOT (
    COALESCE("permissions", '{}'::jsonb) ? 'createPolls'
    AND COALESCE("permissions", '{}'::jsonb) ? 'createThreads'
    AND COALESCE("permissions", '{}'::jsonb) ? 'sendMessagesInThreads'
    AND COALESCE("permissions", '{}'::jsonb) ? 'requestToSpeak'
  );
