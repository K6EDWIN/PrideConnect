import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/resend-verification/route";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";
import { consumeRateLimit } from "@/lib/rate-limit";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    verificationToken: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/gmail", () => ({ sendAppEmail: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 60 }),
  rateLimitResponse: vi.fn(),
}));

describe("POST /api/auth/resend-verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_URL = "https://prideconnect.example";
    consumeRateLimit.mockResolvedValue({ allowed: true, retryAfter: 60 });
    prisma.$transaction.mockImplementation(async (callback) => callback({
      verificationToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
    }));
    sendAppEmail.mockResolvedValue({ messageId: "mail-1" });
  });

  it("creates a fresh expiring token and sends it without disclosing account state", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "member-1", email: "member@example.com", isVerified: false, isDeleted: false, profile: { fullName: "Member" } });
    const response = await POST(new Request("https://prideconnect.example/api/auth/resend-verification", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: " MEMBER@example.com " }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatch(/if an unverified account matches/i);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(sendAppEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "member@example.com" }));
  });

  it("returns the same public response for an unknown account and sends no email", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const response = await POST(new Request("https://prideconnect.example/api/auth/resend-verification", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody@example.com" }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatch(/if an unverified account matches/i);
    expect(sendAppEmail).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
