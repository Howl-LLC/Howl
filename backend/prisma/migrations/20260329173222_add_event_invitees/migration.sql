-- CreateTable
CREATE TABLE "EventInvitee" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "targetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventInvitee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventInvitee_eventId_idx" ON "EventInvitee"("eventId");

-- CreateIndex
CREATE INDEX "EventInvitee_targetId_idx" ON "EventInvitee"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "EventInvitee_eventId_scope_targetId_key" ON "EventInvitee"("eventId", "scope", "targetId");

-- AddForeignKey
ALTER TABLE "EventInvitee" ADD CONSTRAINT "EventInvitee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ServerEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
