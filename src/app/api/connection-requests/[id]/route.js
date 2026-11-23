import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { ensureConversation } from "@/lib/conversations";
import { logActivity } from "@/lib/audit-log";
import { readRequestJson } from "@/lib/request-json";

const VALID_STATUSES = ["ACCEPTED", "DECLINED"];

// PATCH /api/connection-requests/[id]
// Accept or decline a received connection request. Only the recipient may
// respond, and only while it's still PENDING.
export async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = await readRequestJson(request);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  }
  const { status } = parsed.data;

  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: "status must be ACCEPTED or DECLINED" },
      { status: 400 }
    );
  }

  const existing = await prisma.connectionRequest.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (existing.receiverId !== session.user.id) {
    return NextResponse.json(
      { error: "Only the recipient can respond to this request" },
      { status: 403 }
    );
  }
  if (existing.status !== "PENDING") {
    return NextResponse.json(
      { error: "This request has already been responded to" },
      { status: 409 }
    );
  }

  const connectionRequest = await prisma.connectionRequest.update({
    where: { id },
    data: { status },
  });

  if (status === "ACCEPTED") {
    await ensureConversation(existing.senderId, existing.receiverId);
  }

  const responder = await prisma.profile.findUnique({ where: { userId: session.user.id }, select: { fullName: true } });
  await createNotification({
      userId: existing.senderId,
      type: `CONNECTION_${status}`,
      title: status === "ACCEPTED" ? "Connection request accepted" : "Connection request declined",
      message: `${responder?.fullName || "A stakeholder"} ${status === "ACCEPTED" ? "accepted" : "declined"} your connection request.`,
      href: "/requests",
  });

  const senderProfile = await prisma.profile.findUnique({ where: { userId: existing.senderId }, select: { fullName: true } });
  await logActivity({
    actorId: session.user.id,
    targetId: existing.senderId,
    actionType: `CONNECTION_REQUEST_${status}`,
    summary: `${status === "ACCEPTED" ? "Accepted" : "Declined"} ${senderProfile?.fullName || "a member"}’s connection request`,
    details: { requestId: connectionRequest.id, requestStatus: status },
  });

  return NextResponse.json({ connectionRequest });
}
