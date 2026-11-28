import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getActiveChallenge, resendEmailChallenge } from "@/lib/two-factor-challenges";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const limit = await consumeRateLimit({ request, scope: "two-factor-setup-resend-user", identity: session.user.id, limit: 4, windowMs: 15 * 60 * 1000 });
  if (!limit.allowed) return rateLimitResponse(limit.retryAfter);
  const body = await request.json().catch(() => ({}));
  const challenge = await getActiveChallenge(body.challengeToken, "SETUP");
  if (!challenge || challenge.userId !== session.user.id || challenge.method !== "EMAIL") {
    return NextResponse.json({ error: "This verification request can no longer receive a new code." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const result = await resendEmailChallenge({ token: body.challengeToken, purpose: "SETUP" });
  if (result === false) return NextResponse.json({ error: "We could not send a new verification email. Try again later." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!result) return NextResponse.json({ error: "This verification request can no longer receive a new code." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ message: "A new verification code has been sent.", expiresAt: result.expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
