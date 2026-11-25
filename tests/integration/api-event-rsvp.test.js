import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/events/[id]/rsvp/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    event: { findUnique: vi.fn() },
    eventParticipant: { upsert: vi.fn() },
  },
}));

describe("POST /api/events/[id]/rsvp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an event that has already started, even when called directly", async () => {
    getServerSession.mockResolvedValue({ user: { id: "member-1" } });
    prisma.event.findUnique.mockResolvedValue({ id: "event-1", title: "Past event", isHidden: false, eventDate: new Date(Date.now() - 60_000) });
    const response = await POST(new Request("https://example.test/api/events/event-1/rsvp", { method: "POST" }), { params: Promise.resolve({ id: "event-1" }) });
    expect(response.status).toBe(410);
    expect(prisma.eventParticipant.upsert).not.toHaveBeenCalled();
  });

  it("allows a verified session to RSVP to a future event", async () => {
    getServerSession.mockResolvedValue({ user: { id: "member-1" } });
    prisma.event.findUnique.mockResolvedValue({ id: "event-1", title: "Future event", isHidden: false, eventDate: new Date(Date.now() + 60_000) });
    prisma.eventParticipant.upsert.mockResolvedValue({});
    const response = await POST(new Request("https://example.test/api/events/event-1/rsvp", { method: "POST" }), { params: Promise.resolve({ id: "event-1" }) });
    expect(response.status).toBe(200);
    expect(prisma.eventParticipant.upsert).toHaveBeenCalledOnce();
  });
});
