import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";

// POST /api/events/[id]/rsvp
// Joins the logged-in user to the event.
export async function POST(request, { params }) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  const event = await prisma.event.findUnique({ where: { id } });
  if (!event || event.isHidden) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  if (event.eventDate <= new Date()) {
    return NextResponse.json({ error: "Registration is closed because this event has already started." }, { status: 410 });
  }

  await prisma.eventParticipant.upsert({
    where: { eventId_userId: { eventId: id, userId: session.user.id } },
    update: {},
    create: { eventId: id, userId: session.user.id },
  });

  await logActivity({
    actorId: session.user.id,
    targetId: session.user.id,
    actionType: "EVENT_RSVP_ADDED",
    summary: `Registered interest in the event “${event.title}”`,
    details: { eventId: id, title: event.title },
  });

  return NextResponse.json({ joined: true });
}

// DELETE /api/events/[id]/rsvp
// Removes the logged-in user's RSVP.
export async function DELETE(request, { params }) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  const event = await prisma.event.findUnique({ where: { id }, select: { title: true } });

  await prisma.eventParticipant.deleteMany({
    where: { eventId: id, userId: session.user.id },
  });

  if (event) await logActivity({
    actorId: session.user.id,
    targetId: session.user.id,
    actionType: "EVENT_RSVP_REMOVED",
    summary: `Cancelled registration for the event “${event.title}”`,
    details: { eventId: id, title: event.title },
  });

  return NextResponse.json({ joined: false });
}
