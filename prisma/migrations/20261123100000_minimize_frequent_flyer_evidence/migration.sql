-- Keep evidence only while a request is pending; preserve review outcome and audit trail.
ALTER TABLE "FrequentFlyerVerification"
ALTER COLUMN "evidenceCiphertext" DROP NOT NULL;

UPDATE "FrequentFlyerVerification"
SET "evidenceCiphertext" = NULL
WHERE "status" <> 'PENDING';
