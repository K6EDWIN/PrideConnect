import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createEvent } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as createOpportunity } from "@/app/api/opportunities/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";

const deferredAfter = vi.hoisted(() => ({ callback: null }));

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, after: vi.fn((callback) => { deferredAfter.callback = callback; }) };
});
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/gmail", () => ({ GMAIL_SENDER: "sender@example.com", sendAppEmail: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    event: { create: vi.fn(), findFirst: vi.fn() },
    opportunity: { create: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

function post(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("event and opportunity publishing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deferredAfter.callback = null;
    getServerSession.mockResolvedValue({ user: { id: "member-1" } });
  });

  it("publishes an event with its banner and sends a private member announcement", async () => {
    process.env.APP_URL = "https://prideconnect.example";
    prisma.event.create.mockResolvedValue({
      id: "event-1",
      title: "Aviation Careers Evening",
      description: "Meet the operations team.",
      location: "Nairobi",
      bannerUrl: "https://example.public.blob.vercel-storage.com/banner.webp",
      eventDate: new Date("2026-12-01T15:00:00.000Z"),
    });
    prisma.user.findMany.mockResolvedValue([{ email: "one@example.com" }, { email: "two@example.com" }]);

    const response = await createEvent(post("http://localhost:3000/api/events", {
      title: "Aviation Careers Evening",
      description: "Meet the operations team.",
      location: "Nairobi",
      eventDate: "2026-12-01T15:00:00.000Z",
      bannerUrl: "https://example.public.blob.vercel-storage.com/banner.webp",
    }));
    const data = await response.json();
    await deferredAfter.callback?.();

    expect(response.status).toBe(201);
    expect(prisma.event.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bannerUrl: "https://example.public.blob.vercel-storage.com/banner.webp" }),
    }));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isVerified: true, isDeleted: false, isSuspended: false, isDemo: false }),
    }));
    expect(sendAppEmail).toHaveBeenCalledWith(expect.objectContaining({
      bcc: ["one@example.com", "two@example.com"],
      subject: "New event posted: Aviation Careers Evening",
    }));
    expect(data.announcement).toEqual({ queued: true });
    expect(data.event.bannerUrl).toBe("https://example.public.blob.vercel-storage.com/banner.webp");
  });

  it("keeps the event published and logs a failed background announcement", async () => {
    process.env.APP_URL = "https://prideconnect.example";
    prisma.event.create.mockResolvedValue({ id: "event-2", title: "Community Forum", description: null, location: null, bannerUrl: null, eventDate: new Date("2026-12-01T15:00:00.000Z") });
    prisma.user.findMany.mockResolvedValue([{ email: "one@example.com" }]);
    sendAppEmail.mockRejectedValueOnce(new Error("mail server unavailable"));

    const response = await createEvent(post("http://localhost:3000/api/events", {
      title: "Community Forum", eventDate: "2026-12-01T15:00:00.000Z",
    }));
    const data = await response.json();
    const loggedError = vi.spyOn(console, "error").mockImplementation(() => {});
    await deferredAfter.callback?.();

    expect(response.status).toBe(201);
    expect(data.event.id).toBe("event-2");
    expect(data.announcement).toEqual({ queued: true });
    expect(loggedError).toHaveBeenCalled();
    loggedError.mockRestore();
  });

  it("publishes an opportunity through its existing workflow", async () => {
    prisma.opportunity.create.mockResolvedValue({ id: "opportunity-1", title: "Flight Dispatcher Opening" });

    const response = await createOpportunity(post("http://localhost:3000/api/opportunities", {
      title: "Flight Dispatcher Opening",
      description: "Applications are open.",
      type: "Career Opening",
    }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.opportunity.id).toBe("opportunity-1");
  });
});

describe("GET /api/events/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { id: "member-1", role: "STAFF" } });
  });

  it("returns the requested event with organiser, gallery, and RSVP state", async () => {
    prisma.event.findFirst.mockResolvedValue({
      id: "event-1",
      title: "Aviation Careers Evening",
      description: "Meet the operations team.",
      location: "Nairobi",
      bannerUrl: "https://preview.public.blob.vercel-storage.com/event.webp",
      photoUrls: ["https://preview.public.blob.vercel-storage.com/photo.webp"],
      eventDate: new Date(Date.now() + 60_000),
      createdById: "organiser-1",
      createdBy: { profile: { fullName: "Aviation Alumni" } },
      _count: { participants: 4 },
      participants: [{ userId: "member-1" }],
    });

    const response = await getEvent(new Request("https://example.test/api/events/event-1"), { params: Promise.resolve({ id: "event-1" }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(prisma.event.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "event-1", isHidden: false, createdBy: { isDeleted: false } },
    }));
    expect(data.event).toMatchObject({ id: "event-1", createdByName: "Aviation Alumni", participantCount: 4, isJoined: true, canManage: false });
    expect(data.event.photoUrls).toHaveLength(1);
  });

  it("does not expose event details to signed-out visitors", async () => {
    getServerSession.mockResolvedValueOnce(null);
    const response = await getEvent(new Request("https://example.test/api/events/event-1"), { params: Promise.resolve({ id: "event-1" }) });
    expect(response.status).toBe(401);
    expect(prisma.event.findFirst).not.toHaveBeenCalled();
  });
});
