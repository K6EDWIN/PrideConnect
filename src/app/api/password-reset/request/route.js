import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAppUrl, escapeHtml } from "@/lib/app-url";
import { sendAppEmail } from "@/lib/gmail";
import { createPasswordResetToken, PASSWORD_RESET_COOLDOWN_MS, PASSWORD_RESET_TTL_MS } from "@/lib/password-reset";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const GENERIC_RESPONSE = {
  message: "If an active account uses that email, a password reset link will be sent shortly.",
};
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const addressLimit = await consumeRateLimit({ request, scope: "password-reset-ip", limit: 8, windowMs: 15 * 60 * 1000 });
  if (!addressLimit.allowed) return rateLimitResponse(addressLimit.retryAfter);
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_REGEX.test(email) || email.length > 254) {
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
  }

  try {
    const emailLimit = await consumeRateLimit({ request, scope: "password-reset-email", identity: email, limit: 3, windowMs: 60 * 60 * 1000 });
    if (!emailLimit.allowed) return NextResponse.json(GENERIC_RESPONSE, { status: 202, headers: { "Cache-Control": "no-store" } });
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, isVerified: true, isSuspended: true, isDeleted: true, isDemo: true, passwordHash: true, profile: { select: { fullName: true } } },
    });
    if (!user || !user.isVerified || user.isSuspended || user.isDeleted || !user.passwordHash || (process.env.NODE_ENV === "production" && user.isDemo)) {
      return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
    }

    const now = new Date();
    const existing = await prisma.passwordResetToken.findUnique({ where: { userId: user.id } });
    if (existing && !existing.usedAt && existing.expiresAt > now && now.getTime() - existing.createdAt.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
      return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
    }

    const { token, tokenHash } = createPasswordResetToken();
    await prisma.passwordResetToken.upsert({
      where: { userId: user.id },
      update: { tokenHash, expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS), usedAt: null, createdAt: now },
      create: { userId: user.id, tokenHash, expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS) },
    });

    try {
      const resetUrl = buildAppUrl("/reset-password", { token });
      const name = escapeHtml(user.profile?.fullName || "member");
      await sendAppEmail({
        to: user.email,
        subject: "Reset your Kenya Airways PrideConnect password",
        html: `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:600px;margin:auto"><h2>Hello ${name},</h2><p>We received a request to reset your PrideConnect password. This link expires in 30 minutes and works once.</p><p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#c8102e;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Reset password</a></p><p>If you did not request this, you can ignore this email.</p></div>`,
        text: `Hello ${user.profile?.fullName || "member"},\n\nReset your PrideConnect password using this link (expires in 30 minutes and works once):\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
      });
    } catch (emailError) {
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, tokenHash } });
      console.error("Password reset email could not be sent:", emailError);
    }

    return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
  } catch (error) {
    console.error("Password reset request failed:", error);
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
  }
}
