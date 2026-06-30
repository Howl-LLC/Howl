-- CreateTable
CREATE TABLE "ActivityHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "details" TEXT,
    "largeImage" TEXT,
    "smallImage" TEXT,
    "platformId" TEXT,
    "platform" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ActivityHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityHistory_userId_startedAt_idx" ON "ActivityHistory"("userId", "startedAt");

-- AddForeignKey
ALTER TABLE "ActivityHistory" ADD CONSTRAINT "ActivityHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
