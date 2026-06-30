-- Fix CustomEmoji imageUrl: strip origin prefix, keep /api/uploads/... path
UPDATE "CustomEmoji"
SET "imageUrl" = '/api' || split_part("imageUrl", '/api', 2)
WHERE "imageUrl" LIKE 'http%/api/uploads/%';

-- Fix Sticker imageUrl: same treatment
UPDATE "Sticker"
SET "imageUrl" = '/api' || split_part("imageUrl", '/api', 2)
WHERE "imageUrl" LIKE 'http%/api/uploads/%';

-- Fix SoundboardSound audioUrl: same treatment
UPDATE "SoundboardSound"
SET "audioUrl" = '/api' || split_part("audioUrl", '/api', 2)
WHERE "audioUrl" LIKE 'http%/api/uploads/%';
