-- AlterTable
ALTER TABLE "StageSession" ADD COLUMN     "allowEmojis" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowGifs" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowStickers" BOOLEAN NOT NULL DEFAULT false;
