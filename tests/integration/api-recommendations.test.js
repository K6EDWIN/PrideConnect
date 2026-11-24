import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/recommendations/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    profile: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    mentorshipRequest: {
      findMany: vi.fn(),
    },
    connectionRequest: {
      findMany: vi.fn(),
    },
    feedback: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    mLModelArtifact: {
      findMany: vi.fn(),
    },
    recommendation: {
      upsert: vi.fn(),
    },
    recommendationEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
      createMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

// Keep API tests independent from ML_SERVICE_URL in CI. The hosted provider is
// an external service and should be covered by its own integration check.
vi.mock("@/lib/hosted-ml", () => ({
  getAdaptivePredictions: vi.fn(async ({ candidates, localModel }) => ({
    provider: "LOCAL",
    model: {
      active: localModel.active,
      sampleCount: localModel.sampleCount,
      acceptedCount: localModel.acceptedCount,
      declinedCount: localModel.declinedCount,
      confidence: localModel.confidence,
      weights: localModel.weights || null,
    },
    predictions: candidates.map(() => null),
  })),
}));

describe("GET /api/recommendations API Endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.feedback.findMany.mockResolvedValue([]);
    prisma.feedback.count.mockResolvedValue(0);
    prisma.mLModelArtifact.findMany.mockResolvedValue([]);
    prisma.recommendationEvent.findMany.mockResolvedValue([]);
    prisma.recommendationEvent.count.mockResolvedValue(0);
    prisma.recommendationEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it("returns 401 if the user is unauthenticated", async () => {
    getServerSession.mockResolvedValueOnce(null);

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBe("Not authenticated");
  });

  it("returns 404 if the authenticated user has no profile", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { id: "user-1", email: "test@kq.com" },
    });
    prisma.profile.findUnique.mockResolvedValueOnce(null);

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBe("Profile not found");
  });

  it("computes, ranks, and returns recommendations sorted by hybridScore", async () => {
    const userId = "user-me";
    getServerSession.mockResolvedValueOnce({
      user: { id: userId, email: "pilot@kq.com" },
    });

    // Current user's profile: has skill-1, skill-2, interest-1
    prisma.profile.findUnique.mockResolvedValueOnce({
      userId,
      skills: [{ skillId: "s1" }, { skillId: "s2" }],
      interests: [{ interestId: "i1" }],
    });

    // Candidates: candidate 1 shares s1, s2, i1 (high match), candidate 2 shares no skills (low match)
    const mockCandidates = [
      {
        fullName: "Captain Jane",
        department: "Flight Operations",
        bio: "Senior pilot",
        mentorshipRole: "MENTOR",
        user: { id: "user-jane", role: "STAFF" },
        skills: [{ skillId: "s1", skill: { name: "Flight Operations" } }, { skillId: "s2", skill: { name: "Crew Resource Management" } }],
        interests: [{ interestId: "i1", interest: { name: "Mentorship" } }],
      },
      {
        fullName: "Junior Trainee",
        department: "Ground Crew",
        bio: "Apprentice",
        mentorshipRole: "MENTEE",
        user: { id: "user-junior", role: "ALUMNI" },
        skills: [{ skillId: "s99", skill: { name: "Baggage Logistics" } }],
        interests: [{ interestId: "i99", interest: { name: "Aviation Tech" } }],
      },
    ];
    prisma.$queryRaw.mockResolvedValueOnce([{ userId: "user-jane" }, { userId: "user-junior" }]);
    prisma.profile.findMany.mockResolvedValueOnce(mockCandidates);

    // Mock interaction history
    prisma.mentorshipRequest.findMany.mockResolvedValueOnce([]);
    prisma.mentorshipRequest.findMany.mockResolvedValueOnce([]);
    prisma.connectionRequest.findMany.mockResolvedValueOnce([]);
    prisma.connectionRequest.findMany.mockResolvedValueOnce([]);
    prisma.$transaction.mockResolvedValueOnce([]);

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendations).toBeDefined();
    expect(data.recommendations.length).toBe(2);

    // Highest match should be ranked first
    expect(data.recommendations[0].fullName).toBe("Captain Jane");
    expect(data.recommendations[0].matchPercent).toBeGreaterThan(data.recommendations[1].matchPercent);
    expect(data.recommendations[0].rankingPercent).toBeDefined();
    expect(data.recommendations[0].sharedSkills).toContain("Flight Operations");
    expect(data.recommendations[0].sharedInterests).toContain("Mentorship");

    // Check meta telemetry
    expect(data.meta.totalInteractions).toBe(0);
    expect(data.meta.model).toMatchObject({
      active: false,
      trainingExamples: 0,
      acceptedExamples: 0,
      declinedExamples: 0,
      confidence: 0,
      status: "GATHERING_OUTCOMES",
    });
    expect(prisma.recommendationEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: expect.arrayContaining([
        expect.objectContaining({ eventType: "SERVED", dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]),
    }));
  });
});
