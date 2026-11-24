import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as register } from "@/app/api/register/route";
import { prisma } from "@/lib/prisma";
import { decryptFrequentFlyerEvidence } from "@/lib/frequent-flyer-verification";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    verificationToken: { create: vi.fn() },
    rateLimitBucket: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/gmail", () => ({ sendAppEmail: vi.fn().mockResolvedValue({ messageId: "verify" }) }));
vi.mock("@/lib/audit-log", () => ({ logActivity: vi.fn() }));

function post(body) {
  return new Request("https://prideconnect.example/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

const validFlyer = {
  email: "flyer@example.com",
  password: "securePassword123",
  fullName: "Aviation Member",
  role: "FREQUENT_FLYER",
  department: "Aviation Community",
  bio: "Interested in aviation mentoring.",
  mentorshipRole: "MENTEE",
  frequentFlyerEvidence: {
    asanteRewardsNumber: "ASANTE-102938",
    lastFlightAirline: "Kenya Airways",
    lastFlightNumber: "KQ 102",
    origin: "NBO",
    destination: "MBA",
    lastFlightDate: "2026-10-01",
    consent: true,
  },
};

describe("Frequent Flyer registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ count: 1, windowStartedAt: new Date() }]);
    prisma.rateLimitBucket.deleteMany.mockResolvedValue({ count: 0 });
    process.env.APP_URL = "https://prideconnect.example";
    process.env.FREQUENT_FLYER_VERIFICATION_KEY = Buffer.alloc(32, 7).toString("base64");
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: "flyer-1", email: validFlyer.email, role: "FREQUENT_FLYER", profile: { fullName: validFlyer.fullName } });
    prisma.verificationToken.create.mockResolvedValue({ id: "email-token" });
  });

  it("requires review consent and does not create an account without it", async () => {
    const response = await register(post({ ...validFlyer, frequentFlyerEvidence: { ...validFlyer.frequentFlyerEvidence, consent: false } }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Consent is required/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("validates route codes before registration", async () => {
    const response = await register(post({ ...validFlyer, frequentFlyerEvidence: { ...validFlyer.frequentFlyerEvidence, destination: "NBO" } }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/different three-letter airport codes/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("stores flight and Asante details encrypted in the private review record", async () => {
    const response = await register(post(validFlyer));
    expect(response.status).toBe(202);
    const createArgs = prisma.user.create.mock.calls[0][0];
    const ciphertext = createArgs.data.frequentFlyerVerification.create.evidenceCiphertext;
    expect(ciphertext).not.toContain(validFlyer.frequentFlyerEvidence.asanteRewardsNumber);
    expect(decryptFrequentFlyerEvidence(ciphertext)).toEqual({
      asanteRewardsNumber: "ASANTE-102938",
      lastFlightAirline: "KENYA AIRWAYS",
      lastFlightNumber: "KQ 102",
      origin: "NBO",
      destination: "MBA",
      lastFlightDate: "2026-10-01",
    });
    expect(createArgs.data.profile.create).toMatchObject({
      fullName: validFlyer.fullName,
      bio: validFlyer.bio,
      mentorshipRole: "MENTEE",
      isPublic: false,
    });
    expect(createArgs.data.frequentFlyerVerification.create).toEqual({ evidenceCiphertext: ciphertext });
  });
});
