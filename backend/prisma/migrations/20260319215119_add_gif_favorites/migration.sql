-- CreateTable
CREATE TABLE "GifFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gifUrl" TEXT NOT NULL,
    "previewUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GifFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GifFavorite_userId_createdAt_idx" ON "GifFavorite"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GifFavorite_userId_gifUrl_key" ON "GifFavorite"("userId", "gifUrl");

-- AddForeignKey
ALTER TABLE "GifFavorite" ADD CONSTRAINT "GifFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
