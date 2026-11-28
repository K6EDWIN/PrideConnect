import { NextResponse } from "next/server";
import { validatePasswordCredentials } from "@/lib/password-auth";
import { createTwoFactorChallenge } from "@/lib/two-factor-challenges";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(request) {
  const ipLimit = await consumeRateLimit({ request, scope: "two-factor-challenge-ip", limit: 10, windowMs: 15 * 60 * 1000 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfter);
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const emailLimit = await consumeRateLimit({ request, scope: "two-factor-challenge-email", identity: email || "invalid", limit: 5, windowMs: 15 * 60 * 1000 });
  if (!emailLimit.allowed) return rateLimitResponse(emailLimit.retryAfter);
  const user = await validatePasswordCredentials(email, body.password);
  if (!user) return NextResponse.json({ error: "Unable to sign in with those credentials. Check your details or use account recovery." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!user.twoFactorEnabled) return NextResponse.json({ requiresTwoFactor: false }, { headers: { "Cache-Control": "no-store" } });

  try {
    const challenge = await createTwoFactorChallenge({ user, purpose: "LOGIN" });
    return NextResponse.json({ requiresTwoFactor: true, challengeToken: challenge.token, method: user.twoFactorMethod, expiresAt: challenge.expiresAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.status === 429 ? error.message : "We could not start two-step verification. Try again shortly." }, { status: error.status || 503, ...(error.retryAfter ? { headers: { "Retry-After": String(error.retryAfter), "Cache-Control": "no-store" } } : { headers: { "Cache-Control": "no-store" } }) });
  }
}
