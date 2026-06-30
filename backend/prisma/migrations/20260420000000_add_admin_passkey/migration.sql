-- AdminPasskey — WebAuthn credentials registered for admin users. Required
-- second factor alongside TOTP for admin login. Schema mirrors
-- PasskeyCredential for regular users; separate table so admin auth stays
-- fully isolated from user auth (different JWT secret, different tables).

CREATE TABLE "AdminPasskey" (
  "id"           TEXT         NOT NULL,
  "adminUserId"  TEXT         NOT NULL,
  "credentialId" TEXT         NOT NULL,
  "publicKey"    TEXT         NOT NULL,
  "counter"      INTEGER      NOT NULL DEFAULT 0,
  "deviceType"   TEXT         NOT NULL DEFAULT 'singleDevice',
  "backedUp"     BOOLEAN      NOT NULL DEFAULT false,
  "transports"   TEXT,
  "friendlyName" TEXT         NOT NULL DEFAULT 'Admin Passkey',
  "lastUsedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminPasskey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminPasskey_credentialId_key" ON "AdminPasskey"("credentialId");
CREATE INDEX "AdminPasskey_adminUserId_idx" ON "AdminPasskey"("adminUserId");

ALTER TABLE "AdminPasskey"
  ADD CONSTRAINT "AdminPasskey_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
