-- MLS PQC X-Wing flip: change MlsGroup.cipherSuite default 1 -> 83
-- (MLS_256_XWING_AES256GCM_SHA512_Ed25519). Default-only ALTER, affects NEW rows
-- only. Existing suite-1 rows are purged at cutover by the operator-gated
-- backend/scripts/purge-mls.ts, so there is no backfill.
--
-- Hand-trimmed: prisma migrate dev also wants to drop the search_vector FTS
-- columns/indexes on Message/DMMessage and rename MemberRole FK constraints
-- (managed outside Prisma in 20260408213119_add_search_vectors). Those are NOT
-- included here.
ALTER TABLE "MlsGroup" ALTER COLUMN "cipherSuite" SET DEFAULT 83;
