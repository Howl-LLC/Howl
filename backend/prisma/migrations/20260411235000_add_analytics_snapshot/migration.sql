-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "region" TEXT NOT NULL,
    "onlineCount" INTEGER NOT NULL,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_timestamp_idx" ON "AnalyticsSnapshot"("timestamp");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_region_timestamp_idx" ON "AnalyticsSnapshot"("region", "timestamp");
