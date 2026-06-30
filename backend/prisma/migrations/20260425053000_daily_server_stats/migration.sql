-- Server insights worker rollup table.
--
-- One row per (serverId, date). Populated by the BullMQ `serverStats`
-- worker at 00:30 UTC for the previous UTC day. Read by the owner-facing
-- `GET /api/v1/servers/:serverId/insights` endpoint (Cap take ≤ 90 rows).
--
-- DM E2E sanctity: the worker queries Server / ServerMember / Channel /
-- Message only. DM tables are explicitly NOT touched — DMs are E2E
-- encrypted and the server stores only opaque ciphertext.

-- CreateTable
CREATE TABLE "DailyServerStats" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "members" INTEGER NOT NULL DEFAULT 0,
    "joins" INTEGER NOT NULL DEFAULT 0,
    "leaves" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "voiceMinutes" INTEGER NOT NULL DEFAULT 0,
    "retainedAfter7d" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyServerStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyServerStats_serverId_date_key" ON "DailyServerStats"("serverId", "date");

-- CreateIndex
CREATE INDEX "DailyServerStats_serverId_date_idx" ON "DailyServerStats"("serverId", "date");

-- AddForeignKey
ALTER TABLE "DailyServerStats" ADD CONSTRAINT "DailyServerStats_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
