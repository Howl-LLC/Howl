-- CreateTable
CREATE TABLE "ProtocolDistributionSnapshot" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buildDate" TEXT,
    "platform" TEXT NOT NULL,
    "protocolVersion" INTEGER,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ProtocolDistributionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProtocolDistributionSnapshot_timestamp_idx" ON "ProtocolDistributionSnapshot"("timestamp");

-- CreateIndex
CREATE INDEX "ProtocolDistributionSnapshot_buildDate_idx" ON "ProtocolDistributionSnapshot"("buildDate");
