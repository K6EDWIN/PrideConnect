import { after } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { processNotificationEmailQueue, requeueNotificationEmails } from "@/lib/notifications";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (session.user.role !== "ADMIN") return { response: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { session };
}

export async function GET() {
  const { response } = await requireAdmin();
  if (response) return response;
  try {
    const groups = await prisma.notificationEmailDelivery.groupBy({ by: ["status"], _count: { _all: true } });
    return NextResponse.json({
      counts: Object.fromEntries(groups.map((group) => [group.status, group._count._all])),
    });
  } catch (error) {
    console.error("Could not load notification email delivery status:", error);
    return NextResponse.json({ error: "Email delivery status is unavailable. Confirm the notification delivery migration is applied." }, { status: 503 });
  }
}

export async function POST() {
  const { response, session } = await requireAdmin();
  if (response) return response;
  try {
    const resetCount = await requeueNotificationEmails();
    await prisma.adminAction.create({
      data: {
        adminId: session.user.id,
        actionType: "NOTIFICATION_EMAIL_RETRY_REQUESTED",
        notes: JSON.stringify({ actorType: "ADMIN", failedDeliveryCount: resetCount }),
      },
    });
    after(async () => {
      try {
        await processNotificationEmailQueue({ limit: 10 });
      } catch (error) {
        console.error("Could not retry queued notification email deliveries:", error);
      }
    });
    return NextResponse.json({ message: "Email retries have been queued.", resetCount });
  } catch (error) {
    console.error("Could not retry notification email deliveries:", error);
    return NextResponse.json({ error: "Could not queue notification email retries." }, { status: 500 });
  }
}
