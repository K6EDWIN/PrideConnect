import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";
import { buildAppUrl, escapeHtml } from "@/lib/app-url";

function safeNotificationPath(href) {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")
    ? href
    : "/notifications";
}

async function emailNotification(notification) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: notification.userId },
      select: {
        email: true,
        isVerified: true,
        isDeleted: true,
        isSuspended: true,
        isDemo: true,
        profile: { select: { fullName: true } },
      },
    });
    if (!user?.email || !user.isVerified || user.isDeleted || user.isSuspended || user.isDemo) return;

    const title = String(notification.title || "PrideConnect notification").replace(/[\r\n]+/g, " ").slice(0, 140);
    const message = String(notification.message || "You have a new notification.");
    const recipientName = user.profile?.fullName?.trim().split(/\s+/)[0] || "member";
    const viewUrl = buildAppUrl(safeNotificationPath(notification.href));
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const safeUrl = escapeHtml(viewUrl);
    const html = `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:600px;margin:auto"><p>Hello ${escapeHtml(recipientName)},</p><h2 style="color:#c8102e">${safeTitle}</h2><p>${safeMessage}</p><p><a href="${safeUrl}" style="display:inline-block;background:#c8102e;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Open PrideConnect</a></p><p style="font-size:12px;color:#64748b">This email was sent to the address registered to your PrideConnect account.</p></div>`;
    const text = `Hello ${recipientName},\n\n${title}\n${message}\n\nOpen PrideConnect: ${viewUrl}\n\nThis email was sent to the address registered to your PrideConnect account.`;

    await sendAppEmail({
      to: user.email,
      subject: `PrideConnect: ${title}`,
      html,
      text,
    });
  } catch (error) {
    // Email delivery must not roll back the in-app notification or the action
    // that created it. Keep the failure visible in server logs for operators.
    console.error(`Could not email PrideConnect notification ${notification.id} to its recipient:`, error);
  }
}

export async function createNotification(data) {
  let notification;
  try {
    notification = await prisma.notification.create({ data });
  } catch (error) {
    // Core request actions must remain available while a deployment is waiting
    // for the additive notifications migration to reach its database.
    console.warn("Could not save notification:", error.message);
    return null;
  }

  try {
    after(() => emailNotification(notification));
  } catch (error) {
    // `after` requires a Next.js request context. All current call sites are
    // route handlers; retain the in-app record if a future caller lacks one.
    console.error(`Could not schedule email for PrideConnect notification ${notification.id}:`, error);
  }

  return notification;
}
