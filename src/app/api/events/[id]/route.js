import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";

function validBlobUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function GET(_request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const event = await prisma.event.findFirst({
    where: { id, isHidden: false, createdBy: { isDeleted: false } },
    select: {
      id: true,
      title: true,
      description: true,
      location: true,
      bannerUrl: true,
      photoUrls: true,
      eventDate: true,
      createdById: true,
      createdBy: { select: { profile: { select: { fullName: true } } } },
      _count: { select: { participants: true } },
      participants: { where: { userId: session.user.id }, select: { userId: true }, take: 1 },
    },
  });
  if (!event) return NextResponse.json({ error: "This event is no longer available." }, { status: 404 });

  return NextResponse.json({ event: {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    bannerUrl: event.bannerUrl,
    photoUrls: event.photoUrls || [],
    eventDate: event.eventDate,
    canManage: event.createdById === session.user.id || session.user.role === "ADMIN",
    isPast: event.eventDate < new Date(),
    createdByName: event.createdBy?.profile?.fullName || "Unknown",
    participantCount: event._count.participants,
    isJoined: event.participants.some((participant) => participant.userId === session.user.id),
  } });
}

export async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const event = await prisma.event.findUnique({ where: { id }, select: { id: true, title: true, createdById: true, isHidden: true } });
  if (!event || event.isHidden) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  if (event.createdById !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Only the event organiser or an administrator can edit this event." }, { status: 403 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter valid event details and try again." }, { status: 400 });
  }

  const { title, description, location, eventDate, bannerUrl, photoUrls } = payload || {};
  if (typeof title !== "string" || !title.trim() || title.trim().length > 160
    || typeof eventDate !== "string" || !Array.isArray(photoUrls) || photoUrls.length > 8
    || photoUrls.some((url) => !validBlobUrl(url))
    || (bannerUrl !== null && bannerUrl !== "" && !validBlobUrl(bannerUrl))) {
    return NextResponse.json({ error: "Check the title, date, banner, and event photos, then try again." }, { status: 400 });
  }

  const parsedDate = new Date(eventDate);
  if (Number.isNaN(parsedDate.getTime())) return NextResponse.json({ error: "Enter a valid event date." }, { status: 400 });
  if (typeof description !== "string" || description.trim().length > 10000
    || typeof location !== "string" || location.trim().length > 240) {
    return NextResponse.json({ error: "Event descriptions must be under 10,000 characters and locations under 240 characters." }, { status: 400 });
  }

  const updated = await prisma.event.update({
    where: { id },
    data: {
      title: title.trim(),
      description: description.trim() || null,
      location: location.trim() || null,
      eventDate: parsedDate,
      bannerUrl: bannerUrl || null,
      photoUrls,
    },
    select: { id: true, title: true, description: true, location: true, eventDate: true, bannerUrl: true, photoUrls: true },
  });

  await logActivity({
    actorId: session.user.id,
    targetId: event.createdById,
    actionType: "EVENT_UPDATED",
    summary: `Updated the event “${updated.title}”`,
    details: { eventId: id, eventOwnerId: event.createdById, administratorEdit: session.user.role === "ADMIN" && event.createdById !== session.user.id },
  });

  return NextResponse.json({ event: updated });
}
