-- CreateTable
CREATE TABLE "EncryptedMessageArchive" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channelId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "nonce" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncryptedMessageArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingKeyDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "encryptedKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingKeyDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelArchiveKey" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelArchiveKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EncryptedMessageArchive_userId_messageId_key" ON "EncryptedMessageArchive"("userId", "messageId");

-- CreateIndex
CREATE INDEX "EncryptedMessageArchive_userId_channelId_createdAt_idx" ON "EncryptedMessageArchive"("userId", "channelId", "createdAt");

-- CreateIndex
CREATE INDEX "EncryptedMessageArchive_createdAt_idx" ON "EncryptedMessageArchive"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingKeyDelivery_deviceId_channelId_key" ON "PendingKeyDelivery"("deviceId", "channelId");

-- CreateIndex
CREATE INDEX "PendingKeyDelivery_deviceId_idx" ON "PendingKeyDelivery"("deviceId");

-- CreateIndex
CREATE INDEX "PendingKeyDelivery_createdAt_idx" ON "PendingKeyDelivery"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelArchiveKey_userId_channelId_key" ON "ChannelArchiveKey"("userId", "channelId");
