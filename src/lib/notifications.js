import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";
import { buildAppUrl, escapeHtml } from "@/lib/app-url";

const MAX_DELIVERY_ATTEMPTS = 7;
const MAX_QUEUE_BATCH = 10;

function safeNotificationPath(href) {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")
    ? href
    : "/notifications";
}

async function emailNotification(notification, user) {
  const title = String(notification.title || "PrideConnect notification").replace(/[\r\n]+/g, " ").slice(0, 140);
  const message = String(notification.message || "You have a new notification.");
  const recipientName = user.profile?.fullName?.trim().split(/\s+/)[0] || "member";
  const viewUrl = buildAppUrl(safeNotificationPath(notification.href));
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeUrl = escapeHtml(viewUrl);
  const html = `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:600px;margin:auto"><p>Hello ${escapeHtml(recipientName)},</p><h2 style="color:#c8102e">${safeTitle}</h2><p>${safeMessage}</p><p><a href="${safeUrl}" style="display:inline-block;background:#c8102e;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Open PrideConnect</a></p><p style="font-size:12px;color:#64748b">This email was sent to the address registered to your PrideConnect account.</p></div>`;
  const text = `Hello ${recipientName},\n\n${title}\n${message}\n\nOpen PrideConnect: ${viewUrl}\n\nThis email was sent to the address registered to your PrideConnect account.`;

  await sendAppEmail({ to: user.email, subject: `PrideConnect: ${title}`, html, text });
}

function isEligibleRecipient(user) {
  return Boolean(user?.email && user.isVerified && !user.isDeleted && !user.isSuspended && !user.isDemo);
}

export async function processNotificationEmailQueue({ limit = 5 } = {}) {
  const batchSize = Math.min(MAX_QUEUE_BATCH, Math.max(1, Number.parseInt(limit, 10) || 5));
  const claimed = await prisma.$transaction((tx) => tx.$queryRaw`
    WITH candidates AS (
      SELECT "id"
      FROM "NotificationEmailDelivery"
      WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= NOW())
         OR ("status" = 'PROCESSING' AND "processingAt" < NOW() - INTERVAL '10 minutes')
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "NotificationEmailDelivery" AS delivery
    SET "status" = 'PROCESSING',
        "processingAt" = NOW(),
        "attempts" = delivery."attempts" + 1,
        "updatedAt" = NOW()
    FROM candidates
    WHERE delivery."id" = candidates."id"
    RETURNING delivery."id", delivery."notificationId", delivery."attempts"
  `);

  if (!claimed.length) return { claimed: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };
  const deliveries = await prisma.notificationEmailDelivery.findMany({
    where: { id: { in: claimed.map((row) => row.id) } },
    include: {
      notification: {
        include: {
          user: { select: { email: true, isVerified: true, isDeleted: true, isSuspended: true, isDemo: true, profile: { select: { fullName: true } } } },
        },
      },
    },
  });
  const attemptsById = new Map(claimed.map((row) => [row.id, row.attempts]));
  const result = { claimed: claimed.length, sent: 0, failed: 0, skipped: 0, retrying: 0 };

  for (const delivery of deliveries) {
    const user = delivery.notification?.user;
    if (!isEligibleRecipient(user)) {
      await prisma.notificationEmailDelivery.update({
        where: { id: delivery.id },
        data: { status: "SKIPPED", processingAt: null, lastError: null },
      });
      result.skipped += 1;
      continue;
    }

    try {
      await emailNotification(delivery.notification, user);
      await prisma.notificationEmailDelivery.update({
        where: { id: delivery.id },
        data: { status: "SENT", processingAt: null, deliveredAt: new Date(), lastError: null },
      });
      result.sent += 1;
    } catch (error) {
      const attempts = attemptsById.get(delivery.id) || MAX_DELIVERY_ATTEMPTS;
      const terminal = attempts >= MAX_DELIVERY_ATTEMPTS;
      const delayMs = Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempts - 1)));
      await prisma.notificationEmailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: terminal ? "FAILED" : "PENDING",
          processingAt: null,
          nextAttemptAt: new Date(Date.now() + delayMs),
          lastError: String(error?.message || "Email provider error").slice(0, 500),
        },
      });
      console.error(`Could not email PrideConnect notification ${delivery.notificationId}:`, error);
      if (terminal) result.failed += 1;
      else result.retrying += 1;
    }
  }

  return result;
}

export async function requeueNotificationEmails() {
  const result = await prisma.notificationEmailDelivery.updateMany({
    where: { status: { in: ["PENDING", "FAILED"] } },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), processingAt: null, lastError: null },
  });
  return result.count;
}

export async function createNotification(data) {
  let notification;
  try {
    notification = await prisma.notification.create({ data });
  } catch (error) {
    // Core request actions remain available during deployment of additive notification migrations.
    console.warn("Could not save notification:", error.message);
    return null;
  }

  try {
    await prisma.notificationEmailDelivery.create({ data: { notificationId: notification.id } });
    after(async () => {
      try {
        await processNotificationEmailQueue({ limit: 5 });
      } catch (error) {
        // A durable PENDING queue row remains available for retry from the admin console.
        console.error(`Could not process PrideConnect notification email queue for ${notification.id}:`, error);
      }
    });
  } catch (error) {
    // Older deployments without the outbox table keep the previous best-effort send path.
    console.error(`Could not queue notification email ${notification.id}:`, error);
    try {
      after(async () => {
        try {
          const user = await prisma.user.findUnique({
            where: { id: notification.userId },
            select: { email: true, isVerified: true, isDeleted: true, isSuspended: true, isDemo: true, profile: { select: { fullName: true } } },
          });
          if (isEligibleRecipient(user)) await emailNotification(notification, user);
        } catch (sendError) {
          console.error(`Could not email PrideConnect notification ${notification.id}:`, sendError);
        }
      });
    } catch (scheduleError) {
      console.error(`Could not schedule notification email ${notification.id}:`, scheduleError);
    }
  }

  return notification;
}
