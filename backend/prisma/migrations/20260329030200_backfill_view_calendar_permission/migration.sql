-- Backfill: add viewCalendar permission to all existing Member roles
UPDATE "ServerRole"
SET permissions = permissions || '{"viewCalendar": true}'::jsonb
WHERE name = 'Member'
  AND (permissions IS NULL OR NOT (permissions ? 'viewCalendar'));
