import { prisma } from "@/lib/prisma";
import { escapeHtml } from "@/lib/app-url";
import { sendAppEmail } from "@/lib/gmail";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  createChallengeToken,
  createEmailCode,
  hashChallengeToken,
  hashTwoFactorCode,
  decryptTotpSecret,
  findTotpCounter,
  constantTimeHexEqual,
} from "@/lib/two-factor";

export const LOGIN_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_CHALLENGE_ATTEMPTS = 5;

export async function createTwoFactorChallenge({ user, purpose = "LOGIN", method = user.twoFactorMethod }) {
  const issueLimit = await consumeRateLimit({
    scope: "two-factor-challenge-issue-user",
    identity: `${user.id}:${purpose}`,
    limit: 6,
    windowMs: 15 * 60 * 1000,
  });
  if (!issueLimit.allowed) {
    const error = new Error("Too many verification requests. Try again later.");
    error.status = 429;
    error.retryAfter = issueLimit.retryAfter;
    throw error;
  }
  const { token, tokenHash } = createChallengeToken();
  const emailCode = method === "EMAIL" ? createEmailCode() : null;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (emailCode ? EMAIL_CODE_TTL_MS : LOGIN_CHALLENGE_TTL_MS));
  const challenge = await prisma.twoFactorChallenge.create({
    data: {
      userId: user.id,
      tokenHash,
      purpose,
      method,
      codeHash: emailCode ? hashTwoFactorCode(emailCode) : null,
      expiresAt,
    },
  });

  if (emailCode) {
    try {
      const name = escapeHtml(user.profile?.fullName || "member");
      await sendAppEmail({
        to: user.email,
        subject: "Your PrideConnect sign-in verification code",
        html: `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:600px;margin:auto"><h2>Hello ${name},</h2><p>Your PrideConnect verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:8px">${emailCode}</p><p>This code expires in five minutes and can only be used once. If you did not try to sign in, change your password.</p></div>`,
        text: `Your PrideConnect verification code is ${emailCode}. It expires in five minutes and can only be used once. If you did not try to sign in, change your password.`,
      });
    } catch (error) {
      await prisma.twoFactorChallenge.deleteMany({ where: { id: challenge.id } });
      throw new Error("We could not send the verification email. Try again shortly.", { cause: error });
    }
  }

  return { token, expiresAt };
}

export async function getActiveChallenge(token, purpose = "LOGIN") {
  if (typeof token !== "string" || token.length < 40 || token.length > 100) return null;
  return prisma.twoFactorChallenge.findUnique({
    where: { tokenHash: hashChallengeToken(token) },
    include: { user: { include: { frequentFlyerVerification: { select: { status: true } }, profile: { select: { fullName: true } } } } },
  }).then((challenge) => {
    if (!challenge || challenge.purpose !== purpose || challenge.consumedAt || challenge.expiresAt <= new Date() || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) return null;
    return challenge;
  });
}

export async function verifyChallengeCode(challenge, rawCode) {
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  const user = challenge.user;
  let valid = false;
  let recoveryCodeHash = null;
  let totpCounter = null;

  if (challenge.method === "AUTHENTICATOR" && /^\d{6}$/.test(code) && user.twoFactorSecretEncrypted) {
    try {
      totpCounter = findTotpCounter(decryptTotpSecret(user.twoFactorSecretEncrypted), code);
      valid = totpCounter !== null;
    } catch {
      valid = false;
    }
  } else if (challenge.method === "EMAIL" && /^\d{6}$/.test(code) && challenge.codeHash) {
    valid = constantTimeHexEqual(hashTwoFactorCode(code), challenge.codeHash);
  }

  // Recovery codes are allowed as a secure fallback for either enabled method.
  if (!valid && user.twoFactorEnabled && /^[A-Fa-f0-9]{5}-?[A-Fa-f0-9]{5}$/.test(code)) {
    recoveryCodeHash = hashTwoFactorCode(code.replace("-", ""));
    const availableRecoveryCode = await prisma.twoFactorRecoveryCode.findFirst({ where: { userId: user.id, codeHash: recoveryCodeHash, usedAt: null }, select: { id: true } });
    valid = Boolean(availableRecoveryCode);
  }

  if (!valid) {
    await prisma.twoFactorChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    return null;
  }

  const consumedChallenge = await prisma.twoFactorChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
    data: { consumedAt: new Date() },
  });
  if (consumedChallenge.count !== 1) return null;
  if (recoveryCodeHash) {
    const consumedRecoveryCode = await prisma.twoFactorRecoveryCode.updateMany({
      where: { userId: user.id, codeHash: recoveryCodeHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumedRecoveryCode.count !== 1) return null;
  }
  if (totpCounter !== null) {
    const consumedTotpCounter = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ twoFactorLastCounter: null }, { twoFactorLastCounter: { lt: BigInt(totpCounter) } }],
      },
      data: { twoFactorLastCounter: BigInt(totpCounter) },
    });
    if (consumedTotpCounter.count !== 1) return null;
  }
  return user;
}

export async function resendEmailChallenge({ token, purpose = "LOGIN" }) {
  const challenge = await getActiveChallenge(token, purpose);
  if (!challenge || challenge.method !== "EMAIL" || challenge.resendCount >= 3) return null;
  const code = createEmailCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);
  const updated = await prisma.twoFactorChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, resendCount: { lt: 3 } },
    data: { codeHash: hashTwoFactorCode(code), attempts: 0, resendCount: { increment: 1 }, expiresAt },
  });
  if (updated.count !== 1) return null;
  try {
    const name = escapeHtml(challenge.user.profile?.fullName || "member");
    await sendAppEmail({
      to: challenge.user.email,
      subject: "Your PrideConnect sign-in verification code",
      html: `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:600px;margin:auto"><h2>Hello ${name},</h2><p>Your new PrideConnect verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:8px">${code}</p><p>This code expires in five minutes and can only be used once.</p></div>`,
      text: `Your new PrideConnect verification code is ${code}. It expires in five minutes and can only be used once.`,
    });
  } catch {
    return false;
  }
  return { expiresAt };
}
