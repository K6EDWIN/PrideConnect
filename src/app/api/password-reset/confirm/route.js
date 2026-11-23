import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { hashPasswordResetToken, isValidPassword } from "@/lib/password-reset";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

function invalidTokenResponse() {
  return NextResponse.json({ error: "This password reset link is invalid, expired, or already used. Request a new link and try again." }, { status: 400 });
}

export async function POST(request) {
  const rateLimit = await consumeRateLimit({ request, scope: "password-reset-confirm-ip", limit: 20, windowMs: 15 * 60 * 1000 });
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit.retryAfter);
  const body = await request.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token : "";
  const password = body.password;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return invalidTokenResponse();
  if (!isValidPassword(password)) {
    return NextResponse.json({ error: "Password must be between 8 and 128 characters." }, { status: 400 });
  }

  const tokenHash = hashPasswordResetToken(token);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, isDeleted: true, isSuspended: true, isVerified: true } } },
  });
  const now = new Date();
  if (!record || record.usedAt || record.expiresAt <= now || record.user.isDeleted || record.user.isSuspended || !record.user.isVerified) {
    return invalidTokenResponse();
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new Error("RESET_TOKEN_ALREADY_USED");
      await tx.user.update({
        where: { id: record.user.id },
        data: { passwordHash, passwordChangedAt: now, sessionVersion: { increment: 1 } },
      });
    });
  } catch (error) {
    if (error.message === "RESET_TOKEN_ALREADY_USED") return invalidTokenResponse();
    console.error("Password reset could not be completed:", error);
    return NextResponse.json({ error: "We could not reset your password right now. Please request a new link and try again." }, { status: 500 });
  }

  return NextResponse.json({ message: "Your password has been changed. Sign in with your new password." });
}
