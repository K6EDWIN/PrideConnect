import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(
      new URL("/login?error=missing_token", request.url)
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const verificationToken = await tx.verificationToken.findUnique({ where: { token } });
    if (!verificationToken) return { status: "invalid" };
    if (verificationToken.expiresAt <= new Date()) {
      await tx.verificationToken.deleteMany({ where: { token, expiresAt: { lte: new Date() } } });
      return { status: "expired" };
    }
    const consumed = await tx.verificationToken.deleteMany({
      where: { token, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) return { status: "invalid" };
    const user = await tx.user.update({
      where: { id: verificationToken.userId },
      data: { isVerified: true },
      select: { id: true, email: true, role: true },
    });
    return { status: "verified", user };
  });

  if (result.status !== "verified") {
    return NextResponse.redirect(new URL(`/login?error=${result.status === "expired" ? "expired_token" : "invalid_token"}`, request.url));
  }
  const { user } = result;

  await logActivity({
    actorId: user.id,
    targetId: user.id,
    actionType: "USER_EMAIL_VERIFIED",
    summary: "Verified their email address",
    details: { email: user.email, role: user.role },
  });

  return NextResponse.redirect(new URL("/login?verified=true", request.url));
}
