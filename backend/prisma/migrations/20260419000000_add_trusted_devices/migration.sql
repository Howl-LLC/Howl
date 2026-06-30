-- Device verification on new-device logins. Adds two tables and a
-- nullable FK on Session so "Settings → Devices" can present sessions
-- grouped by the trusted-device that owns them.

-- 1. TrustedDevice — persistent per-user device entity with a 90-day
--    sliding expiry. Created after a successful email-code challenge on
--    a browser/device that lacked the howl_device_id cookie.
CREATE TABLE "TrustedDevice" (
  "id"              TEXT         NOT NULL,
  "userId"          TEXT         NOT NULL,
  "tokenHash"       TEXT         NOT NULL,
  "label"           TEXT,
  "deviceType"      TEXT,
  "ipHashFirstSeen" TEXT,
  "ipHashLastSeen"  TEXT,
  "lastSeenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");
CREATE INDEX "TrustedDevice_userId_idx"    ON "TrustedDevice"("userId");
CREATE INDEX "TrustedDevice_expiresAt_idx" ON "TrustedDevice"("expiresAt");

ALTER TABLE "TrustedDevice"
  ADD CONSTRAINT "TrustedDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. LoginVerification — short-lived one-time-code row for the email
--    challenge. One active row per (userId, purpose); replaced on resend.
CREATE TABLE "LoginVerification" (
  "id"         TEXT         NOT NULL,
  "userId"     TEXT         NOT NULL,
  "codeHash"   TEXT         NOT NULL,
  "method"     TEXT         NOT NULL,
  "purpose"    TEXT         NOT NULL DEFAULT 'device',
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "attempts"   INTEGER      NOT NULL DEFAULT 0,
  "ipHash"     TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoginVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginVerification_userId_expiresAt_idx" ON "LoginVerification"("userId", "expiresAt");
CREATE INDEX "LoginVerification_expiresAt_idx"        ON "LoginVerification"("expiresAt");

ALTER TABLE "LoginVerification"
  ADD CONSTRAINT "LoginVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Session gets a nullable FK to TrustedDevice so "Settings → Devices"
--    can group sessions under their trust row. SetNull on delete so
--    revoking trust doesn't cascade-delete the active session rows.
ALTER TABLE "Session" ADD COLUMN "trustedDeviceId" TEXT;

CREATE INDEX "Session_trustedDeviceId_idx" ON "Session"("trustedDeviceId");

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_trustedDeviceId_fkey"
  FOREIGN KEY ("trustedDeviceId") REFERENCES "TrustedDevice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
