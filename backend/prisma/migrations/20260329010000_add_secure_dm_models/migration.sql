-- CreateTable
CREATE TABLE "SecureKeyBundle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedBlob" TEXT NOT NULL,
    "blobSalt" TEXT NOT NULL,
    "blobVersion" INTEGER NOT NULL DEFAULT 1,
    "recoveryBlob" TEXT NOT NULL,
    "recoveryNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecureKeyBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingKeyDelivery" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "dmChannelId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "senderPublicKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingKeyDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecureKeyBundle_userId_key" ON "SecureKeyBundle"("userId");

-- CreateIndex
CREATE INDEX "PendingKeyDelivery_recipientId_idx" ON "PendingKeyDelivery"("recipientId");

-- CreateIndex
CREATE INDEX "PendingKeyDelivery_recipientId_dmChannelId_idx" ON "PendingKeyDelivery"("recipientId", "dmChannelId");

-- AddForeignKey
ALTER TABLE "SecureKeyBundle" ADD CONSTRAINT "SecureKeyBundle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
