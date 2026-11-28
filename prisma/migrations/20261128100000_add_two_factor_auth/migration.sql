CREATE TYPE "TwoFactorMethod" AS ENUM ('AUTHENTICATOR', 'EMAIL');
CREATE TYPE "TwoFactorPurpose" AS ENUM ('LOGIN', 'SETUP');

ALTER TABLE "User"
  ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "twoFactorMethod" "TwoFactorMethod",
  ADD COLUMN "twoFactorSecretEncrypted" TEXT,
  ADD COLUMN "twoFactorPendingSecretEncrypted" TEXT,
  ADD COLUMN "twoFactorSetupExpiresAt" TIMESTAMP(3),
  ADD COLUMN "twoFactorLastCounter" BIGINT,
  ADD COLUMN "twoFactorSetupAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TwoFactorChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "purpose" "TwoFactorPurpose" NOT NULL,
  "method" "TwoFactorMethod" NOT NULL,
  "codeHash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "resendCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TwoFactorChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TwoFactorChallenge_tokenHash_key" ON "TwoFactorChallenge"("tokenHash");
CREATE INDEX "TwoFactorChallenge_userId_purpose_expiresAt_idx" ON "TwoFactorChallenge"("userId", "purpose", "expiresAt");

CREATE TABLE "TwoFactorRecoveryCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TwoFactorRecoveryCode_codeHash_key" ON "TwoFactorRecoveryCode"("codeHash");
CREATE INDEX "TwoFactorRecoveryCode_userId_usedAt_idx" ON "TwoFactorRecoveryCode"("userId", "usedAt");

ALTER TABLE "TwoFactorChallenge"
  ADD CONSTRAINT "TwoFactorChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TwoFactorRecoveryCode"
  ADD CONSTRAINT "TwoFactorRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
