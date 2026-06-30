-- AlterTable
ALTER TABLE "User" ADD COLUMN     "backgroundBlur" INTEGER DEFAULT 0,
ADD COLUMN     "backgroundImage" TEXT,
ADD COLUMN     "backgroundOpacity" DOUBLE PRECISION DEFAULT 0.15,
ADD COLUMN     "bgGifAlwaysPlay" BOOLEAN DEFAULT false;
