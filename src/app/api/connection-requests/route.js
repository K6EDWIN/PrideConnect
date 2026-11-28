import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { extractPairFeatures } from "@/lib/adaptive-recommender";
import { buildConnectionsByUser, computeCollaborativeScore } from "@/lib/collaborative";
import { createNotification } from "@/lib/notifications";
import { logActivity } from "@/lib/audit-log";

const COUNTERPART_SELECT = {
  id: true,
  role: true,
  profile: { select: { fullName: true } },
};

// GET /api/connection-requests
// Returns the logged-in user's sent and received connection requests.
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const [sent, received] = await Promise.all([
    prisma.connectionRequest.findMany({
      where: { senderId: session.user.id, receiver: { is: { isDemo: false, isDeleted: false } } },
      include: { receiver: { select: COUNTERPART_SELECT } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.connectionRequest.findMany({
      where: { receiverId: session.user.id, sender: { is: { isDemo: false, isDeleted: false } } },
      include: { sender: { select: COUNTERPART_SELECT } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return NextResponse.json({ sent, received });
}

// POST /api/connection-requests
// Send a (non-mentorship) networking connection request to another
// stakeholder. This -- along with accept/decline in [id]/route.js -- is what
// generates the interaction data collaborative filtering scores against.
export async function POST(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const receiverId = body.receiverId || body.userId || body.targetUserId;

  if (!receiverId) {
    return NextResponse.json(
      { error: "receiverId is required" },
      { status: 400 }
    );
  }
  if (receiverId === session.user.id) {
    return NextResponse.json(
      { error: "You can't send a request to yourself" },
      { status: 400 }
    );
  }
  if (session.user.role === "ADMIN") {
    return NextResponse.json({ error: "Administrator accounts do not join the member connection network" }, { status: 403 });
  }

  const receiver = await prisma.user.findUnique({
    where: { id: receiverId },
    select: {
      id: true,
      role: true,
      isDemo: true,
      isDeleted: true,
      profile: { select: { fullName: true } },
    },
  });
  if (!receiver) {
    return NextResponse.json({ error: "Recipient not found" }, { status: 404 });
  }
  if (receiver.isDemo || receiver.isDeleted || receiver.role === "ADMIN") {
    return NextResponse.json({ error: "Administrator accounts are not available for member matching" }, { status: 403 });
  }

  const acceptedRequest = await prisma.connectionRequest.findFirst({
    where: {
      OR: [
        { senderId: session.user.id, receiverId },
        { senderId: receiverId, receiverId: session.user.id },
      ],
      status: "ACCEPTED",
    },
    orderBy: { createdAt: "desc" },
  });
  if (acceptedRequest) {
    return NextResponse.json({ connectionRequest: acceptedRequest, alreadyConnected: true });
  }

  const incomingRequest = await prisma.connectionRequest.findFirst({
    where: { senderId: receiverId, receiverId: session.user.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (incomingRequest) {
    return NextResponse.json(
      { error: "This member has already sent you a request. Review it in Network Requests.", incomingRequest: true, requestId: incomingRequest.id },
      { status: 409 }
    );
  }

  const existingRequest = await prisma.connectionRequest.findFirst({
    where: { senderId: session.user.id, receiverId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (existingRequest) {
    return NextResponse.json({ connectionRequest: existingRequest, requestPending: true });
  }

  const [senderProfile, receiverProfile, acceptedMentorships, acceptedConnections] = await Promise.all([
    prisma.profile.findUnique({
      where: { userId: session.user.id },
      include: { skills: { include: { skill: true } }, interests: { include: { interest: true } } },
    }),
    prisma.profile.findUnique({
      where: { userId: receiverId },
      include: { skills: { include: { skill: true } }, interests: { include: { interest: true } } },
    }),
    prisma.mentorshipRequest.findMany({
      where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
      select: { senderId: true, receiverId: true },
    }),
    prisma.connectionRequest.findMany({
      where: { status: "ACCEPTED", sender: { is: { isDemo: false, isDeleted: false } }, receiver: { is: { isDemo: false, isDeleted: false } } },
      select: { senderId: true, receiverId: true },
    }),
  ]);

  const connectionRequest = await prisma.connectionRequest.create({
    data: {
      senderId: session.user.id,
      receiverId,
      modelFeatures: senderProfile && receiverProfile
        ? extractPairFeatures(
            senderProfile,
            receiverProfile,
            "CONNECTION",
            computeCollaborativeScore(
              buildConnectionsByUser([...acceptedMentorships, ...acceptedConnections]),
              session.user.id,
              receiverId
            )
          )
        : undefined,
    },
  });

  await createNotification({
      userId: receiverId,
      type: "CONNECTION_REQUEST",
      title: "New connection request",
      message: `${senderProfile?.fullName || "A stakeholder"} would like to connect with you.`,
      href: "/requests",
  });

  await logActivity({
    actorId: session.user.id,
    targetId: receiverId,
    actionType: "CONNECTION_REQUEST_SENT",
    summary: `Sent a connection request to ${receiver.profile?.fullName || "another member"}`,
    details: { requestId: connectionRequest.id, requestStatus: connectionRequest.status },
  });

  return NextResponse.json({ connectionRequest }, { status: 201 });
}
