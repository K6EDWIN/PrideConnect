import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/directory/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    profile: {
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
  },
}));

describe("GET /api/directory API Endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the user is unauthenticated", async () => {
    getServerSession.mockResolvedValueOnce(null);

    const req = new Request("http://localhost:3000/api/directory");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBe("Not authenticated");
  });

  it("lists public verified profiles and maps skills/interests into strings", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { id: "user-current", role: "ALUMNI" },
    });

    const mockProfiles = [
      {
        fullName: "Capt. Alice Smith",
        department: "Flight Operations",
        bio: "Boeing 787 Captain",
        mentorshipRole: "MENTOR",
        availability: "WEEKDAYS",
        user: { id: "user-alice", role: "STAFF" },
        skills: [{ skill: { name: "Avionics" } }],
        interests: [{ interest: { name: "Safety Systems" } }],
      },
    ];

    prisma.profile.findMany.mockResolvedValueOnce(mockProfiles);

    const req = new Request("http://localhost:3000/api/directory?role=STAFF&q=Alice");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0]).toEqual({
      userId: "user-alice",
      role: "STAFF",
      fullName: "Capt. Alice Smith",
      department: "Flight Operations",
      bio: "Boeing 787 Captain",
      mentorshipRole: "MENTOR",
      availability: "WEEKDAYS",
      skills: ["Avionics"],
      interests: ["Safety Systems"],
    });

    // Check that prisma.findMany was called with query filter parameters
    expect(prisma.profile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isPublic: true,
          userId: { not: "user-current" },
        }),
      })
    );
  });

  it("applies the dedicated case-insensitive department filter", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "current-user" } });
    prisma.profile.findMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost:3000/api/directory?department=Flight%20Operations"));

    expect(res.status).toBe(200);
    expect(prisma.profile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        department: { equals: "Flight Operations", mode: "insensitive" },
      }),
    }));
  });

  it("returns public department options while excluding deleted members", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "current-user" } });
    prisma.profile.findMany.mockResolvedValueOnce([
      { department: "Flight Operations" },
      { department: null },
    ]);

    const res = await GET(new Request("http://localhost:3000/api/directory?departments=true"));
    const data = await res.json();

    expect(data.departments).toEqual(["Flight Operations"]);
    expect(prisma.profile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user: expect.objectContaining({ isDeleted: false, isVerified: true, isSuspended: false }),
      }),
      distinct: ["department"],
    }));
  });
});
