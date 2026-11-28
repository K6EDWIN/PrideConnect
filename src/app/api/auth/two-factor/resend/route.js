import { NextResponse } from "next/server";
import { resendEmailChallenge } from "@/lib/two-factor-challenges";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(request) {
  const limit = await consumeRateLimit({ request, scope: "two-factor-resend-ip", limit: 5, windowMs: 15 * 60 * 1000 });
  if (!limit.allowed) return rateLimitResponse(limit.retryAfter);
  const body = await request.json().catch(() => ({}));
  const result = await resendEmailChallenge({ token: body.challengeToken });
  if (result === false) return NextResponse.json({ error: "We could not send a new verification email. Try again later." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!result) return NextResponse.json({ error: "This verification request can no longer receive a new code. Start signing in again." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ message: "A new verification code has been sent.", expiresAt: result.expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
