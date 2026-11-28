import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createTwoFactorChallenge, getActiveChallenge, verifyChallengeCode } from "@/lib/two-factor-challenges";
import {
  buildAuthenticatorUri,
  createRecoveryCodes,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBase32Secret,
  findTotpCounter,
  hashTwoFactorCode,
  verifyTotp,
} from "@/lib/two-factor";
import QRCode from "qrcode";

async function currentUser(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  const limit = await (await import("@/lib/rate-limit")).consumeRateLimit({
    request, scope: "account-two-factor-user", identity: session.user.id, limit: 20, windowMs: 15 * 60 * 1000,
  });
  if (!limit.allowed) return false;
  return prisma.user.findUnique({ where: { id: session.user.id } });
}

export async function GET(request) {
  const user = await currentUser(request);
  if (user === false) return NextResponse.json({ error: "Too many security settings requests. Try again later." }, { status: 429 });
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const remainingRecoveryCodes = await prisma.twoFactorRecoveryCode.count({ where: { userId: user.id, usedAt: null } });
  return NextResponse.json({ enabled: user.twoFactorEnabled, method: user.twoFactorMethod, remainingRecoveryCodes }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const user = await currentUser(request);
  if (user === false) return NextResponse.json({ error: "Too many security settings requests. Try again later." }, { status: 429 });
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const method = body.method;
  if (!['AUTHENTICATOR', 'EMAIL'].includes(method)) return NextResponse.json({ error: "Choose an available verification method." }, { status: 400 });
  if (user.twoFactorEnabled) return NextResponse.json({ error: "Disable two-step verification before changing its method." }, { status: 409 });

  try {
    if (method === "AUTHENTICATOR") {
      const secret = generateBase32Secret();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorPendingSecretEncrypted: encryptTotpSecret(secret), twoFactorSetupExpiresAt: expiresAt, twoFactorSetupAttempts: 0 },
      });
      const uri = buildAuthenticatorUri({ secret, email: user.email });
      const qrCodeDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
      return NextResponse.json({ method, secret, qrCodeDataUrl, expiresAt }, { headers: { "Cache-Control": "no-store" } });
    }

    const challenge = await createTwoFactorChallenge({ user, purpose: "SETUP", method: "EMAIL" });
    return NextResponse.json({ method, challengeToken: challenge.token, expiresAt: challenge.expiresAt, message: "A verification code was sent to your registered email." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.status === 429 ? error.message : error.message || "Could not prepare two-step verification." }, { status: error.status || 503, headers: { "Cache-Control": "no-store", ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) } });
  }
}

export async function PUT(request) {
  const user = await currentUser(request);
  if (user === false) return NextResponse.json({ error: "Too many security settings requests. Try again later." }, { status: 429 });
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const method = body.method;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (user.twoFactorEnabled) return NextResponse.json({ error: "Two-step verification is already enabled." }, { status: 409 });

  let valid = false;
  let setupCounter = null;
  if (method === "AUTHENTICATOR" && user.twoFactorSetupAttempts < 5 && user.twoFactorPendingSecretEncrypted && user.twoFactorSetupExpiresAt > new Date()) {
    try {
      setupCounter = findTotpCounter(decryptTotpSecret(user.twoFactorPendingSecretEncrypted), code);
      valid = setupCounter !== null;
    } catch { valid = false; }
  } else if (method === "EMAIL") {
    const challenge = await getActiveChallenge(body.challengeToken, "SETUP");
    if (challenge?.userId === user.id && challenge.method === "EMAIL") valid = Boolean(await verifyChallengeCode(challenge, code));
  }
  if (!valid) {
    if (method === "AUTHENTICATOR") {
      await prisma.user.updateMany({ where: { id: user.id, twoFactorSetupAttempts: { lt: 5 } }, data: { twoFactorSetupAttempts: { increment: 1 } } });
    }
    return NextResponse.json({ error: "That verification code is incorrect, expired, or the setup attempt limit has been reached." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const recoveryCodes = createRecoveryCodes();
  await prisma.$transaction(async (transaction) => {
    await transaction.twoFactorRecoveryCode.deleteMany({ where: { userId: user.id } });
    await transaction.twoFactorRecoveryCode.createMany({ data: recoveryCodes.map((recoveryCode) => ({ userId: user.id, codeHash: hashTwoFactorCode(recoveryCode) })) });
    await transaction.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: method,
        twoFactorSecretEncrypted: method === "AUTHENTICATOR" ? user.twoFactorPendingSecretEncrypted : null,
        twoFactorPendingSecretEncrypted: null,
        twoFactorSetupExpiresAt: null,
        twoFactorLastCounter: setupCounter === null ? null : BigInt(setupCounter),
        twoFactorSetupAttempts: 0,
      },
    });
  });
  return NextResponse.json({ enabled: true, method, recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request) {
  const user = await currentUser(request);
  if (user === false) return NextResponse.json({ error: "Too many security settings requests. Try again later." }, { status: 429 });
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!user.twoFactorEnabled) return NextResponse.json({ error: "Two-step verification is not enabled." }, { status: 409 });
  if (!user.passwordHash || typeof body.password !== "string" || !(await bcrypt.compare(body.password, user.passwordHash))) {
    return NextResponse.json({ error: "Enter your current password to turn off two-step verification." }, { status: 400 });
  }

  if (user.twoFactorMethod === "EMAIL") {
    if (!body.challengeToken) {
      try {
        const challenge = await createTwoFactorChallenge({ user, purpose: "SETUP", method: "EMAIL" });
        return NextResponse.json({ challengeToken: challenge.token, needsCode: true, message: "We sent a confirmation code to your registered email." }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return NextResponse.json({ error: "Could not send a confirmation email. Two-step verification remains enabled." }, { status: 503 });
      }
    }
    const challenge = await getActiveChallenge(body.challengeToken, "SETUP");
    if (!challenge || challenge.userId !== user.id || challenge.method !== "EMAIL" || !(await verifyChallengeCode(challenge, body.code))) {
      return NextResponse.json({ error: "The confirmation code is incorrect or expired." }, { status: 400 });
    }
  } else {
    const code = typeof body.code === "string" ? body.code.trim() : "";
    let valid = false;
    if (/^\d{6}$/.test(code) && user.twoFactorSecretEncrypted) {
      try { valid = verifyTotp(decryptTotpSecret(user.twoFactorSecretEncrypted), code); } catch { valid = false; }
    }
    if (!valid && /^[A-Fa-f0-9]{5}-?[A-Fa-f0-9]{5}$/.test(code)) {
      const consumed = await prisma.twoFactorRecoveryCode.updateMany({
        where: { userId: user.id, codeHash: hashTwoFactorCode(code.replace("-", "")), usedAt: null },
        data: { usedAt: new Date() },
      });
      valid = consumed.count === 1;
    }
    if (!valid) return NextResponse.json({ error: "Enter a current authenticator code or an unused recovery code." }, { status: 400 });
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.twoFactorChallenge.deleteMany({ where: { userId: user.id } });
    await transaction.twoFactorRecoveryCode.deleteMany({ where: { userId: user.id } });
    await transaction.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorMethod: null, twoFactorSecretEncrypted: null, twoFactorPendingSecretEncrypted: null, twoFactorSetupExpiresAt: null, twoFactorLastCounter: null, twoFactorSetupAttempts: 0 },
    });
  });
  return NextResponse.json({ enabled: false, message: "Two-step verification has been turned off." }, { headers: { "Cache-Control": "no-store" } });
}
