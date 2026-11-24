ALTER TABLE "RecommendationEvent"
ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "RecommendationEvent_dedupeKey_key"
ON "RecommendationEvent"("dedupeKey");