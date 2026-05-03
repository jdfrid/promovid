ALTER TABLE "Scene"
ADD COLUMN "referenceMediaUrl" TEXT,
ADD COLUMN "generatedVideoUrl" TEXT,
ADD COLUMN "videoProvider" TEXT,
ADD COLUMN "videoPrompt" TEXT,
ADD COLUMN "generationStatus" TEXT;
