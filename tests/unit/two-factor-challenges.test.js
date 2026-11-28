import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, sendAppEmailMock, consumeRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {
    twoFactorChallenge: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    twoFactorRecoveryCode: { findFirst: vi.fn(), updateMany: vi.fn() },
    user: { updateMany: vi.fn() },
  },
  sendAppEmailMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/gmail", () => ({ sendAppEmail: sendAppEmailMock }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: consumeRateLimitMock }));

import { createTwoFactorChallenge, EMAIL_CODE_TTL_MS, getActiveChallenge, verifyChallengeCode } from "@/lib/two-factor-challenges";
import { encryptTotpSecret, hashChallengeToken, hashTwoFactorCode } from "@/lib/two-factor";
import { createHmac } from "node:crypto";

const createChallenge = (overrides = {}) => ({
  id: "challenge-1",
  userId: "member-1",
  tokenHash: hashChallengeToken("secure-challenge-token-12345678901234567890"),
  purpose: "LOGIN",
  method: "EMAIL",
  codeHash: hashTwoFactorCode("123456"),
  attempts: 0,
  resendCount: 0,
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  user: { id: "member-1", twoFactorEnabled: true, twoFactorMethod: "EMAIL", isVerified: true },
  ...overrides,
});

describe("two-factor challenge controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXTAUTH_SECRET = "test-only-secret-for-unit-tests";
    consumeRateLimitMock.mockResolvedValue({ allowed: true });
    prismaMock.twoFactorChallenge.create.mockResolvedValue({ id: "challenge-created" });
    sendAppEmailMock.mockResolvedValue({ messageId: "test-message" });
    prismaMock.twoFactorChallenge.findUnique.mockResolvedValue(createChallenge());
    prismaMock.twoFactorChallenge.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.twoFactorRecoveryCode.findFirst.mockResolvedValue(null);
    prismaMock.twoFactorRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects missing, expired, consumed, and attempt-locked challenges", async () => {
    expect(await getActiveChallenge("short", "LOGIN")).toBeNull();
    prismaMock.twoFactorChallenge.findUnique.mockResolvedValueOnce(createChallenge({ expiresAt: new Date(Date.now() - 1) }));
    expect(await getActiveChallenge("secure-challenge-token-12345678901234567890", "LOGIN")).toBeNull();
    prismaMock.twoFactorChallenge.findUnique.mockResolvedValueOnce(createChallenge({ consumedAt: new Date() }));
    expect(await getActiveChallenge("secure-challenge-token-12345678901234567890", "LOGIN")).toBeNull();
    prismaMock.twoFactorChallenge.findUnique.mockResolvedValueOnce(createChallenge({ attempts: 5 }));
    expect(await getActiveChallenge("secure-challenge-token-12345678901234567890", "LOGIN")).toBeNull();
  });

  it("increments attempts on an incorrect email code and consumes a correct code once", async () => {
    const challenge = createChallenge();
    expect(await verifyChallengeCode(challenge, "654321")).toBeNull();
    expect(prismaMock.twoFactorChallenge.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: challenge.id, attempts: { lt: 5 } }),
      data: { attempts: { increment: 1 } },
    }));

    prismaMock.twoFactorChallenge.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await verifyChallengeCode(challenge, "123456")).toMatchObject({ id: "member-1" });
    expect(prismaMock.twoFactorChallenge.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: challenge.id, consumedAt: null }),
      data: expect.objectContaining({ consumedAt: expect.any(Date) }),
    }));
  });

  it("accepts a recovery code only once", async () => {
    const challenge = createChallenge({ method: "AUTHENTICATOR", codeHash: null });
    prismaMock.twoFactorRecoveryCode.findFirst.mockResolvedValue({ id: "recovery-1" });
    expect(await verifyChallengeCode(challenge, "abcde-f0123")).toMatchObject({ id: "member-1" });
    expect(prismaMock.twoFactorRecoveryCode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "member-1", codeHash: hashTwoFactorCode("abcdeF0123"), usedAt: null },
    }));
  });

  it("prevents reuse of an authenticator time step across different challenges", async () => {
    process.env.TWO_FACTOR_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const counter = Math.floor(Date.now() / 30_000);
    const keyText = "12345678901234567890";
    const key = Buffer.from(keyText);
    const movingFactor = Buffer.alloc(8);
    movingFactor.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac("sha1", key).update(movingFactor).digest();
    const offset = digest[digest.length - 1] & 15;
    const binary = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
    const code = String(binary % 1_000_000).padStart(6, "0");
    const challenge = createChallenge({
      method: "AUTHENTICATOR",
      codeHash: null,
      user: { id: "member-1", twoFactorEnabled: true, twoFactorSecretEncrypted: encryptTotpSecret(secret) },
    });

    expect(await verifyChallengeCode(challenge, code)).toMatchObject({ id: "member-1" });
    expect(prismaMock.user.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "member-1", OR: [{ twoFactorLastCounter: null }, { twoFactorLastCounter: { lt: BigInt(counter) } }] }),
      data: { twoFactorLastCounter: BigInt(counter) },
    }));
    prismaMock.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await verifyChallengeCode({ ...challenge, id: "challenge-2" }, code)).toBeNull();
  });

  it("emails a short-lived code but stores only its keyed hash and challenge-token hash", async () => {
    let persistedData;
    prismaMock.twoFactorChallenge.create.mockImplementation(async ({ data }) => {
      persistedData = data;
      return { id: "email-login-challenge" };
    });
    const before = Date.now();
    const result = await createTwoFactorChallenge({
      user: { id: "member-1", email: "member@example.com", profile: { fullName: "Member" } },
      purpose: "LOGIN",
      method: "EMAIL",
    });
    const sentText = sendAppEmailMock.mock.calls[0][0].text;
    const sentCode = sentText.match(/\b\d{6}\b/)[0];

    expect(result.token).not.toBe(persistedData.tokenHash);
    expect(persistedData.tokenHash).toBe(hashChallengeToken(result.token));
    expect(persistedData.codeHash).toBe(hashTwoFactorCode(sentCode));
    expect(persistedData.codeHash).not.toBe(sentCode);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + EMAIL_CODE_TTL_MS - 1000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(before + EMAIL_CODE_TTL_MS + 1000);
    expect(sentText).toContain("five minutes");
  });
});
