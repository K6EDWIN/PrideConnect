import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasAcceptedRelationship } from "@/lib/conversations";
import { createNotification } from "@/lib/notifications";
import { logActivity } from "@/lib/audit-log";

async function getConversationForMember(id, userId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      participantOne: { select: { id: true, isDemo: true, isDeleted: true, profile: { select: { fullName: true } } } },
      participantTwo: { select: { id: true, isDemo: true, isDeleted: true, profile: { select: { fullName: true } } } },
    },
  });
  if (!conversation) return { error: "Conversation not found", status: 404 };
  if (conversation.participantOne.isDemo || conversation.participantTwo.isDemo) {
    return { error: "Demo accounts are not part of the live member network", status: 404 };
  }
  if (conversation.participantOne.isDeleted || conversation.participantTwo.isDeleted) {
    return { error: "This conversation is no longer available", status: 404 };
  }
  if (conversation.participantOneId !== userId && conversation.participantTwoId !== userId) {
    return { error: "You do not have access to this conversation", status: 403 };
  }
  const partnerId = conversation.participantOneId === userId
    ? conversation.participantTwoId
    : conversation.participantOneId;
  if (!(await hasAcceptedRelationship(userId, partnerId))) {
    return { error: "Messaging is available after a connection or mentorship request is accepted", status: 403 };
  }
  return { conversation, partnerId };
}

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { id } = await params;
  const access = await getConversationForMember(id, session.user.id);
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

  const url = new URL(request.url);
  const beforeId = url.searchParams.get("before");
  let cursorMessage = null;
  if (beforeId) {
    cursorMessage = await prisma.message.findFirst({
      where: { id: beforeId, conversationId: id },
      select: { id: true, createdAt: true },
    });
    if (!cursorMessage) return NextResponse.json({ error: "Message cursor is invalid" }, { status: 400 });
  }

  const where = { conversationId: id };
  if (cursorMessage) {
    where.OR = [
      { createdAt: { lt: cursorMessage.createdAt } },
      { createdAt: cursorMessage.createdAt, id: { lt: cursorMessage.id } },
    ];
  }
  const rows = await prisma.message.findMany({
    where,
    include: { sender: { select: { id: true, profile: { select: { fullName: true } } } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
  });
  const hasMore = rows.length > 100;
  const page = rows.slice(0, 100);
  const messages = page.reverse();
  return NextResponse.json({
    conversation: access.conversation,
    messages,
    hasMore,
    nextCursor: hasMore && messages.length ? messages[0].id : null,
  });
}

export async function POST(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { id } = await params;
  const access = await getConversationForMember(id, session.user.id);
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = await request.json().catch(() => ({}));
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text || text.length > 2000) {
    return NextResponse.json({ error: "Message must contain 1 to 2000 characters" }, { status: 400 });
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { conversationId: id, senderId: session.user.id, body: text },
      include: { sender: { select: { id: true, profile: { select: { fullName: true } } } } },
    });
    await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
    return created;
  });

  await createNotification({
    userId: access.partnerId,
    type: "CHAT_MESSAGE",
    title: "New message",
    message: `${message.sender.profile?.fullName || "A connection"} sent you a message.`,
    href: `/messages?conversationId=${encodeURIComponent(id)}`,
  });
  await logActivity({
    actorId: session.user.id,
    targetId: access.partnerId,
    actionType: "CHAT_MESSAGE_SENT",
    summary: "Sent a private message to a connection",
    details: { conversationId: id, messageLength: text.length },
  });
  return NextResponse.json({ message }, { status: 201 });
}
