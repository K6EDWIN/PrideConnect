import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export function getClientAddress(request) {
  // Vercel overwrites x-real-ip at its trusted edge; ignore caller-supplied forwarding chains.
  if (process.env.VERCEL === "1") {
    const address = request?.headers?.get?.("x-real-ip")?.trim();
    if (address && address.length <= 64 && !/[\s,]/.test(address)) return address;
  }
  // Share a conservative bucket elsewhere until a trusted proxy integration is configured.
  return "shared-untrusted-client-address";
}

function hashBucketKey(scope, value) {
  const secret = process.env.RATE_LIMIT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("RATE_LIMIT_SECRET or NEXTAUTH_SECRET must be configured in production");
  }
  return createHmac("sha256", secret || "local-development").update(`${scope}:${value}`).digest("hex");
}

export async function consumeRateLimit({ request, scope, identity = getClientAddress(request), limit, windowMs }) {
  const key = hashBucketKey(scope, identity);
  const now = new Date();
  const rows = await prisma.$queryRaw(Prisma.sql`
    INSERT INTO "RateLimitBucket" ("key", "count", "windowStartedAt", "expiresAt")
    VALUES (${key}, 1, NOW(), NOW() + ${windowMs} * INTERVAL '1 millisecond')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."windowStartedAt" <= NOW() - ${windowMs} * INTERVAL '1 millisecond' THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "windowStartedAt" = CASE
        WHEN "RateLimitBucket"."windowStartedAt" <= NOW() - ${windowMs} * INTERVAL '1 millisecond' THEN NOW()
        ELSE "RateLimitBucket"."windowStartedAt"
      END,
      "expiresAt" = CASE
        WHEN "RateLimitBucket"."windowStartedAt" <= NOW() - ${windowMs} * INTERVAL '1 millisecond'
          THEN NOW() + ${windowMs} * INTERVAL '1 millisecond'
        ELSE "RateLimitBucket"."expiresAt"
      END
    RETURNING "count", "windowStartedAt"
  `);

  // Prune old IP/email buckets occasionally so the limiter table stays bounded.
  if (Math.random() < 0.01) {
    await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  const row = rows[0];
  const startedAt = row?.windowStartedAt instanceof Date ? row.windowStartedAt : now;
  const retryAfter = Math.max(1, Math.ceil((startedAt.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: Number(row?.count || 0) <= limit, retryAfter };
}

export function rateLimitResponse(retryAfter, message = "Too many attempts. Try again later.") {
  return Response.json({ error: message }, {
    status: 429,
    headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" },
  });
}
