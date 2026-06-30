-- CreateTable
CREATE TABLE "DMChannel" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DMParticipant" (
    "userId" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMParticipant_pkey" PRIMARY KEY ("userId","dmChannelId")
);

-- CreateTable
CREATE TABLE "DMMessage" (
    "id" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DMMessage_dmChannelId_idx" ON "DMMessage"("dmChannelId");

-- AddForeignKey
ALTER TABLE "DMParticipant" ADD CONSTRAINT "DMParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMParticipant" ADD CONSTRAINT "DMParticipant_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMMessage" ADD CONSTRAINT "DMMessage_dmChannelId_fkey" FOREIGN KEY ("dmChannelId") REFERENCES "DMChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
