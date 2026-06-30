-- Part of the "secureDm → dm" rename refactor.
--
-- The Prisma model `SecureKeyBundle` is renamed to `DmKeyBundle` in the
-- schema, but the underlying table name is preserved via `@@map("SecureKeyBundle")`
-- so this migration is non-destructive for the table itself. The only SQL
-- change is dropping the now-dead `FamilyRestriction.blockSecureDm` column
-- (the parental "block Secure DMs" gate is removed since all DMs are E2E
-- encrypted by default and there is no "secure tier" to block separately).

ALTER TABLE "FamilyRestriction" DROP COLUMN "blockSecureDm";
