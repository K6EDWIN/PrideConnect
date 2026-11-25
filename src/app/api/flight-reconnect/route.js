import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";

function nairobiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return parts.filter((part) => part.type !== "literal")
    .map(({ type, value }) => [type, value])
    .reduce((result, [type, value]) => ({ ...result, [type]: value }), {});
}

function parseFlightRoute(flightRoute) {
  // The v2 prefix marks records created after sharing became explicit opt-in.
  // Older records may have a checked-by-default consent value, so they are
  // intentionally excluded from matching until the member logs them again.
  const match = /^v2\|(KQ ?\d{1,4}[A-Z]?)\|([A-Z]{3})\|([A-Z]{3})$/.exec(flightRoute || "");
  return match
    ? { flightNumber: match[1], origin: match[2], destination: match[3] }
    : { flightNumber: null, origin: null, destination: null };
}

// GET /api/flight-reconnect
// Only pairs opted-in, verified members who logged the exact same flight,
// direction, and completed travel date.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const savedFlights = await prisma.flightReconnect.findMany({
    where: { userId: session.user.id },
    orderBy: { travelDate: "desc" },
  });
  const myFlights = savedFlights.map((flight) => ({ ...flight, ...parseFlightRoute(flight.flightRoute) }));
  const consentedFlights = myFlights.filter((flight) =>
    flight.consentToShare && flight.flightNumber && flight.origin && flight.destination
  );

  const flightPairs = [...new Map(consentedFlights.map((flight) => [
    `${flight.flightRoute}:${flight.travelDate.toISOString()}`,
    { flightRoute: flight.flightRoute, travelDate: flight.travelDate },
  ])).values()];
  const others = flightPairs.length ? await prisma.flightReconnect.findMany({
    where: {
      OR: flightPairs.map(({ flightRoute, travelDate }) => ({ flightRoute, travelDate })),
      consentToShare: true,
      userId: { not: session.user.id },
      user: { isVerified: true, isSuspended: false, isDeleted: false, isDemo: false, role: { not: "ADMIN" } },
    },
    include: { user: { select: { id: true, role: true, profile: { select: { fullName: true, department: true } } } } },
  }) : [];
  const pairKeys = new Set(flightPairs.map(({ flightRoute, travelDate }) => `${flightRoute}:${travelDate.toISOString()}`));
  const matches = others
    .filter((other) => pairKeys.has(`${other.flightRoute}:${other.travelDate.toISOString()}`))
    .map((other) => ({
      ...parseFlightRoute(other.flightRoute),
      flightRoute: other.flightRoute,
      travelDate: other.travelDate,
      userId: other.user.id,
      role: other.user.role,
      fullName: other.user.profile?.fullName || "Member",
      department: other.user.profile?.department || null,
    }));

  const peerIds = [...new Set(matches.map((match) => match.userId))];
  const [connectionRequests, mentorshipRequests] = peerIds.length
    ? await Promise.all([
        prisma.connectionRequest.findMany({
          where: {
            OR: [
              { senderId: session.user.id, receiverId: { in: peerIds } },
              { receiverId: session.user.id, senderId: { in: peerIds } },
            ],
          },
          select: { id: true, senderId: true, receiverId: true, status: true, createdAt: true },
        }),
        prisma.mentorshipRequest.findMany({
          where: {
            OR: [
              { senderId: session.user.id, receiverId: { in: peerIds } },
              { receiverId: session.user.id, senderId: { in: peerIds } },
            ],
          },
          select: { id: true, senderId: true, receiverId: true, status: true, createdAt: true },
        }),
      ])
    : [[], []];
  const requests = [
    ...connectionRequests.map((request) => ({ ...request, requestType: "CONNECTION" })),
    ...mentorshipRequests.map((request) => ({ ...request, requestType: "MENTORSHIP" })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const latestRequestByPeer = new Map();
  for (const connectionRequest of requests) {
    const peerId = connectionRequest.senderId === session.user.id
      ? connectionRequest.receiverId
      : connectionRequest.senderId;
    if (connectionRequest.status === "ACCEPTED" || !latestRequestByPeer.has(peerId)) {
      latestRequestByPeer.set(peerId, {
        id: connectionRequest.id,
        status: connectionRequest.status,
        direction: connectionRequest.senderId === session.user.id ? "SENT" : "RECEIVED",
        type: connectionRequest.requestType,
      });
    }
  }

  const uniqueMatches = new Map();
  for (const match of matches) {
    const key = `${match.userId}:${match.flightNumber}:${match.travelDate.toISOString()}`;
    if (uniqueMatches.has(key)) continue;
    const connection = latestRequestByPeer.get(match.userId);
    uniqueMatches.set(key, {
      ...match,
      connectionRequestId: connection?.id || null,
      connectionStatus: connection?.status || null,
      connectionDirection: connection?.direction || null,
      connectionType: connection?.type || null,
    });
  }

  return NextResponse.json({ myFlights, matches: [...uniqueMatches.values()] });
}

// POST /api/flight-reconnect
// Logs a completed itinerary. Sharing is explicit opt-in and defaults off.
export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const flightNumber = typeof body.flightNumber === "string"
    ? body.flightNumber.trim().toUpperCase().replace(/\s+/g, " ")
    : "";
  const origin = typeof body.origin === "string" ? body.origin.trim().toUpperCase() : "";
  const destination = typeof body.destination === "string" ? body.destination.trim().toUpperCase() : "";
  const { travelDate } = body;

  if (!flightNumber || !origin || !destination || !travelDate) {
    return NextResponse.json(
      { error: "Flight number, origin, destination, and travel date are required" },
      { status: 400 }
    );
  }
  if (!/^KQ ?\d{1,4}[A-Z]?$/.test(flightNumber)) {
    return NextResponse.json({ error: "Enter a valid Kenya Airways flight number, such as KQ 102" }, { status: 400 });
  }
  const canonicalFlightNumber = flightNumber.replace(/^KQ ?/, "KQ ");
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) {
    return NextResponse.json({ error: "Origin and destination must be three-letter airport codes" }, { status: 400 });
  }
  if (origin === destination) {
    return NextResponse.json({ error: "Origin and destination must be different airports" }, { status: 400 });
  }
  if (typeof travelDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    return NextResponse.json({ error: "Enter a valid travel date" }, { status: 400 });
  }
  const parsedDate = new Date(`${travelDate}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== travelDate) {
    return NextResponse.json({ error: "Enter a valid travel date" }, { status: 400 });
  }
  const { year, month, day } = nairobiToday();
  const today = `${year}-${month}-${day}`;
  if (travelDate >= today) {
    return NextResponse.json(
      { error: "Flight Reconnect is for completed trips. Choose a date before today." },
      { status: 400 }
    );
  }

  const flightRoute = `v2|${canonicalFlightNumber}|${origin}|${destination}`;
  const existing = await prisma.flightReconnect.findFirst({
    where: { userId: session.user.id, flightRoute, travelDate: parsedDate },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: "You already logged this flight and date" }, { status: 409 });
  }

  const flight = await prisma.flightReconnect.create({
    data: {
      userId: session.user.id,
      flightRoute,
      travelDate: parsedDate,
      consentToShare: body.consentToShare === true,
    },
  });

  await logActivity({
    actorId: session.user.id,
    targetId: session.user.id,
    actionType: "FLIGHT_TRIP_LOGGED",
    summary: `Logged completed flight ${canonicalFlightNumber} (${origin} → ${destination})`,
    details: { flightId: flight.id, flightNumber: canonicalFlightNumber, origin, destination, travelDate, sharingEnabled: flight.consentToShare },
  });

  return NextResponse.json({ flight }, { status: 201 });
}
