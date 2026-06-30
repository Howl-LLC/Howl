-- AIK rotation-attestation chain.
--
-- Additive only — NO backfill: rotations that happened before this deploy
-- legitimately lack links, so pre-deploy-rotated pairs fail closed and fall to
-- manual recovery (the chain is forward-only from here). The server stores these
-- rows opaquely and does zero crypto; signatures are verified client-side, rooted
-- at the verifier's own pinned AIK. The three unique indexes are honest-server
-- defense-in-depth (the client enforces linearity).

-- CreateTable
CREATE TABLE "AikRotation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "oldAik" TEXT NOT NULL,
    "newAik" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AikRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AikHead" (
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "aik" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AikHead_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "AikRotation_userId_idx" ON "AikRotation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AikRotation_userId_seq_key" ON "AikRotation"("userId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AikRotation_userId_oldAik_key" ON "AikRotation"("userId", "oldAik");

-- CreateIndex
CREATE UNIQUE INDEX "AikRotation_userId_newAik_key" ON "AikRotation"("userId", "newAik");

-- AddForeignKey
ALTER TABLE "AikRotation" ADD CONSTRAINT "AikRotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AikHead" ADD CONSTRAINT "AikHead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
