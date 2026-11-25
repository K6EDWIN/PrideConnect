import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureConversation } from "@/lib/conversations";

const participantInclude = {
  select: { id: true, email: true, profile: { select: { fullName: true, department: true } } },
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const userId = session.user.id;
  const [connections, mentorships] = await Promise.all([
    prisma.connectionRequest.findMany({
      where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } }, OR: [{ senderId: userId }, { receiverId: userId }] },
      select: { senderId: true, receiverId: true },
    }),
    prisma.mentorshipRequest.findMany({
      where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } }, OR: [{ senderId: userId }, { receiverId: userId }] },
      select: { senderId: true, receiverId: true },
    }),
  ]);

  // Materialize conversations for accepted relationships created before chat
  // was introduced, so existing members can start messaging immediately.
  const counterpartIds = [...new Set([...connections, ...mentorships].map((item) =>
    item.senderId === userId ? item.receiverId : item.senderId
  ))];
  const conversationWhere = {
    OR: [
      { participantOneId: userId, participantTwo: { is: { isDemo: false, isDeleted: false } } },
      { participantTwoId: userId, participantOne: { is: { isDemo: false, isDeleted: false } } },
    ],
  };
  const conversationInclude = {
    participantOne: participantInclude,
    participantTwo: participantInclude,
    messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true, senderId: true } },
  };
  const existingConversations = await prisma.conversation.findMany({
    where: conversationWhere,
    include: conversationInclude,
    orderBy: { updatedAt: "desc" },
  });
  const existingCounterpartIds = new Set(existingConversations.map((conversation) =>
    conversation.participantOneId === userId ? conversation.participantTwoId : conversation.participantOneId
  ));
  const missingCounterparts = counterpartIds.filter((counterpartId) => !existingCounterpartIds.has(counterpartId));
  await Promise.all(missingCounterparts.map((counterpartId) => ensureConversation(userId, counterpartId)));

  const newConversations = missingCounterparts.length ? await prisma.conversation.findMany({
    where: {
      OR: [
        { participantOneId: userId, participantTwoId: { in: missingCounterparts } },
        { participantTwoId: userId, participantOneId: { in: missingCounterparts } },
      ],
    },
    include: conversationInclude,
    orderBy: { updatedAt: "desc" },
  }) : [];
  const conversations = [...existingConversations, ...newConversations]
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));

  return NextResponse.json({
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      partner: conversation.participantOneId === userId ? conversation.participantTwo : conversation.participantOne,
      lastMessage: conversation.messages[0] || null,
      updatedAt: conversation.updatedAt,
    })),
  });
}
