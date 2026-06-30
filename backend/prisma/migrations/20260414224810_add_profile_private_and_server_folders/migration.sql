-- AlterTable
ALTER TABLE "User" ADD COLUMN     "profilePrivate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ServerFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "color" VARCHAR(7),
    "serverIds" TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerFolder_userId_idx" ON "ServerFolder"("userId");

-- AddForeignKey
ALTER TABLE "ServerFolder" ADD CONSTRAINT "ServerFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
