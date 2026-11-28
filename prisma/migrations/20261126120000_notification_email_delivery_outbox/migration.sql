CREATE TYPE "NotificationEmailStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "NotificationEmailDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "status" "NotificationEmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationEmailDelivery_notificationId_key"
ON "NotificationEmailDelivery"("notificationId");

CREATE INDEX "NotificationEmailDelivery_status_nextAttemptAt_createdAt_idx"
ON "NotificationEmailDelivery"("status", "nextAttemptAt", "createdAt");

ALTER TABLE "NotificationEmailDelivery"
ADD CONSTRAINT "NotificationEmailDelivery_notificationId_fkey"
FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
