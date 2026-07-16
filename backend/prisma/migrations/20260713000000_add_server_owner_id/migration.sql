-- Add authoritative Server.ownerId, backfilled from existing ownership
-- artifacts. After this migration ownership is derived from this column, not
-- the mutable ServerMember.role display string.
ALTER TABLE "Server" ADD COLUMN "ownerId" TEXT;

-- Backfill deterministically: prefer the member holding the locked Owner role
-- (the authoritative artifact), then the legacy role string; tiebreak by
-- earliest join (the creator joins first), then userId. This also heals
-- servers whose owner string drifted but who still hold the Owner role.
UPDATE "Server" s
SET "ownerId" = pick."userId"
FROM (
  SELECT DISTINCT ON (sm."serverId") sm."serverId", sm."userId"
  FROM "ServerMember" sm
  LEFT JOIN "MemberRole" mr
    ON mr."userId" = sm."userId" AND mr."serverId" = sm."serverId"
  LEFT JOIN "ServerRole" sr
    ON sr.id = mr."roleId" AND sr."locked" = true AND sr."isEveryone" = false
  WHERE LOWER(sm."role") = 'owner' OR sr.id IS NOT NULL
  ORDER BY sm."serverId", (sr.id IS NOT NULL) DESC, sm."joinedAt" ASC, sm."userId" ASC
) pick
WHERE pick."serverId" = s.id
  AND s."ownerId" IS NULL;

-- Remediate stale co-owner artifacts (rows that claim owner-ness but are not
-- the authoritative owner): drop their Owner MemberRole (which carries
-- administrator) and demote their display string. Their real permissions
-- continue to come from their remaining MemberRole rows.
DELETE FROM "MemberRole" mr
USING "Server" s, "ServerRole" sr
WHERE mr."serverId" = s.id
  AND sr.id = mr."roleId"
  AND sr."serverId" = s.id
  AND sr."locked" = true
  AND sr."isEveryone" = false
  AND s."ownerId" IS NOT NULL
  AND mr."userId" <> s."ownerId";

UPDATE "ServerMember" sm
SET "role" = 'member', "roleId" = NULL
FROM "Server" s
WHERE sm."serverId" = s.id
  AND s."ownerId" IS NOT NULL
  AND LOWER(sm."role") = 'owner'
  AND sm."userId" <> s."ownerId";

-- Heal the authoritative owner's artifacts so the display string, roleId
-- pointer, and administrator-bearing Owner MemberRole all agree with ownerId.
INSERT INTO "MemberRole" ("userId", "serverId", "roleId")
SELECT s."ownerId", s.id, sr.id
FROM "Server" s
JOIN "ServerRole" sr ON sr."serverId" = s.id AND sr."locked" = true AND sr."isEveryone" = false
JOIN "ServerMember" sm ON sm."serverId" = s.id AND sm."userId" = s."ownerId"
WHERE s."ownerId" IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "ServerMember" sm
SET "role" = sr."name", "roleId" = sr.id
FROM "Server" s
JOIN "ServerRole" sr ON sr."serverId" = s.id AND sr."locked" = true AND sr."isEveryone" = false
WHERE sm."serverId" = s.id
  AND sm."userId" = s."ownerId"
  AND (LOWER(sm."role") <> LOWER(sr."name") OR sm."roleId" IS DISTINCT FROM sr.id);

CREATE INDEX "Server_ownerId_idx" ON "Server"("ownerId");
