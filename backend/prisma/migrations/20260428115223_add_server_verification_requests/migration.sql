-- AlterTable: cached discovery-eligibility timestamp on ServerSettings.
ALTER TABLE "ServerSettings" ADD COLUMN "eligibleForDiscoverySince" TIMESTAMP(3);

-- CreateTable: owner-initiated "Verified by Howl" application.
CREATE TABLE "ServerVerificationRequest" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "websiteUrl" TEXT NOT NULL,
    "additionalNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerVerificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: prevents duplicate pending requests per submitter+server.
CREATE UNIQUE INDEX "ServerVerificationRequest_serverId_submittedById_status_key"
    ON "ServerVerificationRequest"("serverId", "submittedById", "status");

-- CreateIndex: admin-queue hot path (newest pending first).
CREATE INDEX "ServerVerificationRequest_status_createdAt_idx"
    ON "ServerVerificationRequest"("status", "createdAt");

-- CreateIndex: owner status panel + cooldown lookup.
CREATE INDEX "ServerVerificationRequest_serverId_status_idx"
    ON "ServerVerificationRequest"("serverId", "status");

-- AddForeignKey: cascade on server delete.
ALTER TABLE "ServerVerificationRequest"
    ADD CONSTRAINT "ServerVerificationRequest_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: cascade on submitter delete (record meaningless without submitter).
ALTER TABLE "ServerVerificationRequest"
    ADD CONSTRAINT "ServerVerificationRequest_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
