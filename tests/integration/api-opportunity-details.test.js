import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/opportunities/[id]/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: { opportunity: { findFirst: vi.fn() } },
}));

describe("GET /api/opportunities/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { id: "member-1" } });
  });

  it("returns the current community opportunity and publisher details", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: "opp-1",
      title: "Flight Dispatcher Opening",
      description: "Join the operations team.",
      type: "Career Opening",
      division: "Flight Operations",
      employmentType: "Permanent",
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      postedBy: { id: "publisher-1", profile: { fullName: "Aviation Alumni" } },
    });

    const response = await GET(new Request("https://example.test/api/opportunities/opp-1"), { params: Promise.resolve({ id: "opp-1" }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "opp-1", isHidden: false }),
      include: { postedBy: { select: { id: true, profile: { select: { fullName: true } } } } },
    }));
    expect(data.opportunity).toMatchObject({ id: "opp-1", title: "Flight Dispatcher Opening", type: "Career Opening", division: "Flight Operations", source: "community" });
    expect(data.opportunity.postedBy.profile.fullName).toBe("Aviation Alumni");
  });

  it("requires authentication", async () => {
    getServerSession.mockResolvedValueOnce(null);
    const response = await GET(new Request("https://example.test/api/opportunities/opp-1"), { params: Promise.resolve({ id: "opp-1" }) });
    expect(response.status).toBe(401);
    expect(prisma.opportunity.findFirst).not.toHaveBeenCalled();
  });
});
