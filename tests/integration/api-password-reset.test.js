import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { POST as requestPasswordReset } from "@/app/api/password-reset/request/route";
import { POST as confirmPasswordReset } from "@/app/api/password-reset/confirm/route";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";
import { hashPasswordResetToken } from "@/lib/password-reset";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetToken: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    rateLimitBucket: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/gmail", () => ({ GMAIL_SENDER: "sender@example.com", sendAppEmail: vi.fn() }));

function post(url, body) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("password reset workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ count: 1, windowStartedAt: new Date() }]);
    prisma.rateLimitBucket.deleteMany.mockResolvedValue({ count: 0 });
    process.env.APP_URL = "https://prideconnect.example";
    prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
    prisma.passwordResetToken.upsert.mockResolvedValue({});
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({});
    sendAppEmail.mockResolvedValue({ messageId: "reset-email" });
    prisma.$transaction.mockImplementation((callback) => callback({
      passwordResetToken: prisma.passwordResetToken,
      user: prisma.user,
    }));
  });

  it("sends an opaque one-time link and persists only its token hash", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "person@example.com", isVerified: true, isSuspended: false, isDeleted: false, isDemo: false, passwordHash: "existing-hash", profile: { fullName: "A Member" } });
    prisma.passwordResetToken.findUnique.mockResolvedValue(null);

    const response = await requestPasswordReset(post("https://prideconnect.example/api/password-reset/request", { email: "PERSON@example.com" }));
    const data = await response.json();
    const stored = prisma.passwordResetToken.upsert.mock.calls[0][0];
    const emailBody = sendAppEmail.mock.calls[0][0];
    const token = emailBody.text.match(/reset-password\?token=([A-Za-z0-9_-]+)/)?.[1];

    expect(response.status).toBe(202);
    expect(data.message).toMatch(/If an active account/);
    expect(token).toHaveLength(43);
    expect(stored.update.tokenHash).toBe(hashPasswordResetToken(token));
    expect(stored.update.tokenHash).not.toBe(token);
    expect(stored.update.expiresAt.getTime() - stored.update.createdAt.getTime()).toBeGreaterThanOrEqual(30 * 60 * 1000 - 5);
  });

  it("uses the same public response and sends no mail when the account is unavailable", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const response = await requestPasswordReset(post("https://prideconnect.example/api/password-reset/request", { email: "unknown@example.com" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ message: "If an active account uses that email, a password reset link will be sent shortly." });
    expect(sendAppEmail).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.upsert).not.toHaveBeenCalled();
  });

  it("returns a generic response when the per-email reset limit is reached", async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 1, windowStartedAt: new Date() }])
      .mockResolvedValueOnce([{ count: 4, windowStartedAt: new Date() }]);
    const response = await requestPasswordReset(post("https://prideconnect.example/api/password-reset/request", { email: "person@example.com" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ message: "If an active account uses that email, a password reset link will be sent shortly." });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rate limits reset-token confirmation attempts by request address", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 21, windowStartedAt: new Date() }]);
    const response = await confirmPasswordReset(post("https://prideconnect.example/api/password-reset/confirm", { token: "d".repeat(43), password: "NewStrongPass123" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(prisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
  });

  it("hashes and saves a new password and consumes the token atomically", async () => {
    const token = "a".repeat(43);
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: "reset-1", tokenHash: hashPasswordResetToken(token), usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: "user-1", isDeleted: false, isSuspended: false, isVerified: true },
    });

    const response = await confirmPasswordReset(post("https://prideconnect.example/api/password-reset/confirm", { token, password: "NewStrongPass123" }));
    expect(response.status).toBe(200);
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenHash: hashPasswordResetToken(token), usedAt: null }),
      data: expect.objectContaining({ usedAt: expect.any(Date) }),
    }));
    const update = prisma.user.update.mock.calls[0][0];
    expect(update.data.passwordChangedAt).toBeInstanceOf(Date);
    expect(await bcrypt.compare("NewStrongPass123", update.data.passwordHash)).toBe(true);
    expect(update.data.passwordHash).not.toBe("NewStrongPass123");
  });

  it("rejects expired tokens and does not change the password", async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: "reset-old", usedAt: null, expiresAt: new Date(Date.now() - 1000),
      user: { id: "user-1", isDeleted: false, isSuspended: false, isVerified: true },
    });
    const response = await confirmPasswordReset(post("https://prideconnect.example/api/password-reset/confirm", { token: "b".repeat(43), password: "NewStrongPass123" }));
    expect(response.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a token already claimed by another request", async () => {
    const token = "c".repeat(43);
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: "reset-race", usedAt: null, expiresAt: new Date(Date.now() + 60_000),
      user: { id: "user-1", isDeleted: false, isSuspended: false, isVerified: true },
    });
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    const response = await confirmPasswordReset(post("https://prideconnect.example/api/password-reset/confirm", { token, password: "NewStrongPass123" }));
    expect(response.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
