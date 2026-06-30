-- CreateTable
CREATE TABLE "DmVerification" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "safetyNumber" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DmVerification_ownerId_peerId_key" ON "DmVerification"("ownerId", "peerId");

-- CreateIndex
CREATE INDEX "DmVerification_peerId_idx" ON "DmVerification"("peerId");

-- AddForeignKey
ALTER TABLE "DmVerification" ADD CONSTRAINT "DmVerification_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmVerification" ADD CONSTRAINT "DmVerification_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
