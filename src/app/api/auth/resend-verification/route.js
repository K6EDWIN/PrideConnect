import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { sendAppEmail } from "@/lib/gmail";
import { buildAppUrl, escapeHtml } from "@/lib/app-url";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const GENERIC_MESSAGE = "If an unverified account matches that email, a fresh verification link will be sent.";

export async function POST(request) {
  const ipLimit = await consumeRateLimit({ request, scope: "verification-resend-ip", limit: 10, windowMs: 60 * 60 * 1000 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter, "Too many requests. Try again later.");

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  const emailLimit = await consumeRateLimit({ request, scope: "verification-resend-email", identity: email, limit: 3, windowMs: 60 * 60 * 1000 });
  if (!emailLimit.allowed) return NextResponse.json({ message: GENERIC_MESSAGE });

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, isVerified: true, isDeleted: true, profile: { select: { fullName: true } } },
  });
  if (!user || user.isVerified || user.isDeleted) return NextResponse.json({ message: GENERIC_MESSAGE });

  let verifyUrl;
  let token;
  try {
    token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({ where: { userId: user.id } });
      await tx.verificationToken.create({ data: { userId: user.id, token, expiresAt } });
    });
    verifyUrl = new URL("/api/auth/verify", buildAppUrl("/"));
    verifyUrl.searchParams.set("token", token);
    await sendAppEmail({
      to: user.email,
      subject: "Your PrideConnect verification link",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto"><h2>Hello ${escapeHtml(user.profile?.fullName || "member")}</h2><p>Use this secure link to verify your PrideConnect email. It expires in 24 hours.</p><p><a href="${escapeHtml(verifyUrl.toString())}">Verify my email</a></p></div>`,
      text: `Verify your PrideConnect email within 24 hours: ${verifyUrl.toString()}`,
    });
  } catch (error) {
    if (token) {
      await prisma.verificationToken.deleteMany({ where: { token } }).catch(() => {});
    }
    console.error("Verification resend could not be completed", { code: error?.code || "EMAIL_OR_CONFIGURATION_ERROR" });
  }

  return NextResponse.json({ message: GENERIC_MESSAGE });
}
