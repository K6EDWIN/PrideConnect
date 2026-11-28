import { NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";
import { sendAppEmail, GMAIL_SENDER } from "@/lib/gmail";
import { buildAppUrl, escapeHtml } from "@/lib/app-url";

// GET /api/events
// Lists all events, soonest first, with participant count and whether the
// logged-in user has already joined.
export async function GET(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim().slice(0, 120) || "";
  const eventId = params.get("eventId")?.trim() || "";
  const time = params.get("time") || "upcoming";
  const format = params.get("format") || "";
  const requestedPage = Number.parseInt(params.get("page") || "1", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(requestedPage, 100000)) : 1;
  const pageSize = 24;
  const now = new Date();
  const filters = [{ isHidden: false, createdBy: { isDeleted: false } }];
  if (eventId) filters.push({ id: eventId });
  else if (time === "upcoming") filters.push({ eventDate: { gte: now } });
  else if (time === "past") filters.push({ eventDate: { lt: now } });
  if (!eventId && q) filters.push({ OR: [
    { title: { contains: q, mode: "insensitive" } },
    { description: { contains: q, mode: "insensitive" } },
    { location: { contains: q, mode: "insensitive" } },
    { createdBy: { profile: { is: { fullName: { contains: q, mode: "insensitive" } } } } },
  ] });
  const onlineLocationFilters = ["online", "virtual", "teams", "zoom"].map((term) => ({ location: { contains: term, mode: "insensitive" } }));
  if (!eventId && format === "online") filters.push({ OR: onlineLocationFilters });
  if (!eventId && format === "inperson") filters.push({ OR: [
    { location: null },
    { AND: onlineLocationFilters.map((condition) => ({ NOT: condition })) },
  ] });
  const where = { AND: filters };
  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where,
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
      orderBy: { eventDate: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.event.count({ where }),
  ]);

  const withRsvpInfo = events.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    bannerUrl: e.bannerUrl,
    photoUrls: e.photoUrls || [],
    eventDate: e.eventDate,
    canManage: e.createdById === session.user.id || session.user.role === "ADMIN",
    isPast: e.eventDate < new Date(),
    createdByName: e.createdBy?.profile?.fullName || "Unknown",
    participantCount: e._count.participants,
    isJoined: e.participants.some((p) => p.userId === session.user.id),
  }));

  return NextResponse.json({ events: withRsvpInfo, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

// POST /api/events
// Creates a new event.
export async function POST(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter valid event details and try again." }, { status: 400 });
  }
  const { title, description, location, eventDate, bannerUrl, photoUrls = [] } = payload || {};

  if (typeof title !== "string" || !title.trim() || !eventDate) {
    return NextResponse.json(
      { error: "title and eventDate are required" },
      { status: 400 }
    );
  }

  const parsedDate = new Date(eventDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return NextResponse.json({ error: "eventDate is invalid" }, { status: 400 });
  }
  if (parsedDate <= new Date()) {
    return NextResponse.json({ error: "Choose a future date and time for the event." }, { status: 400 });
  }
  if (bannerUrl) {
    let parsedBanner;
    try { parsedBanner = new URL(bannerUrl); } catch { parsedBanner = null; }
    if (typeof bannerUrl !== "string" || parsedBanner?.protocol !== "https:" || parsedBanner.username || parsedBanner.password || !parsedBanner.hostname.endsWith(".public.blob.vercel-storage.com")) {
      return NextResponse.json({ error: "Upload the banner again before publishing." }, { status: 400 });
    }
  }
  if (!Array.isArray(photoUrls) || photoUrls.length > 8 || photoUrls.some((url) => !isEventBlobUrl(url))) {
    return NextResponse.json({ error: "Use up to eight valid uploaded event photos." }, { status: 400 });
  }

  const event = await prisma.event.create({ data: {
    createdById: session.user.id,
    title: title.trim(),
    description: typeof description === "string" ? description.trim() || null : null,
    location: typeof location === "string" ? location.trim() || null : null,
    bannerUrl: bannerUrl || null,
    photoUrls,
    eventDate: parsedDate,
  } });

  await logActivity({
    actorId: session.user.id,
    targetId: session.user.id,
    actionType: "EVENT_CREATED",
    summary: `Created the event “${event.title}”`,
    details: { eventId: event.id, title: event.title, eventDate: parsedDate.toISOString(), location: location || null },
  });

  after(async () => {
    try {
      const members = await prisma.user.findMany({
        where: { isVerified: true, isDeleted: false, isSuspended: false, isDemo: false, id: { not: session.user.id } },
        select: { email: true },
      });
      const recipients = [...new Set(members.map((member) => member.email).filter(Boolean))];
      if (!recipients.length) return;
      const eventUrl = buildAppUrl(`/events/${encodeURIComponent(event.id)}`);
      const safeTitle = escapeHtml(event.title);
      const safeDescription = escapeHtml(event.description || "Join the community for this event.").replace(/\n/g, "<br>");
      const safeLocation = escapeHtml(event.location || "Details to be announced");
      const safeDate = escapeHtml(parsedDate.toLocaleString("en-KE", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Nairobi" }));
      const banner = event.bannerUrl ? `<p><img src="${escapeHtml(event.bannerUrl)}" alt="${safeTitle} banner" style="display:block;width:100%;max-width:640px;height:auto;border-radius:12px"></p>` : "";
      const html = `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:640px;margin:auto"><p style="color:#c8102e;font-weight:bold">NEW EVENT POSTED</p><h1>${safeTitle}</h1>${banner}<p>${safeDescription}</p><p><strong>When:</strong> ${safeDate}<br><strong>Where:</strong> ${safeLocation}</p><p><a href="${escapeHtml(eventUrl)}" style="display:inline-block;background:#c8102e;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">View event</a></p></div>`;
      const text = `NEW EVENT POSTED: ${event.title}\n\n${event.description || "Join the community for this event."}\n\nWhen: ${parsedDate.toLocaleString("en-KE", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Nairobi" })}\nWhere: ${event.location || "Details to be announced"}\n${event.bannerUrl ? `Banner: ${event.bannerUrl}\n` : ""}\nView event: ${eventUrl}`;
      for (let index = 0; index < recipients.length; index += 40) {
        await sendAppEmail({ to: GMAIL_SENDER, bcc: recipients.slice(index, index + 40), subject: `New event posted: ${event.title.replace(/[\r\n]+/g, " ").slice(0, 160)}`, html, text });
      }
      console.info(`Event announcement sent for ${event.id} to ${recipients.length} members.`);
    } catch (error) {
      console.error("Event was published, but the member announcement could not be sent:", error);
    }
  });

  return NextResponse.json({ event, announcement: { queued: true } }, { status: 201 });
}

function isEventBlobUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}
