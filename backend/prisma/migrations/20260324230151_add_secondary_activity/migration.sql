-- CreateTable
CREATE TABLE "UserSecondaryActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "details" TEXT,
    "state" TEXT,
    "largeImage" TEXT,
    "smallImage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platformId" TEXT,
    "platform" TEXT,
    "durationMs" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSecondaryActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSecondaryActivity_userId_key" ON "UserSecondaryActivity"("userId");

-- CreateIndex
CREATE INDEX "UserSecondaryActivity_userId_idx" ON "UserSecondaryActivity"("userId");

-- AddForeignKey
ALTER TABLE "UserSecondaryActivity" ADD CONSTRAINT "UserSecondaryActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
