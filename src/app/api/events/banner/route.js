import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const MAX_BANNER_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function matchesImageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.type === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (file.type === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const uploadLimit = await consumeRateLimit({ request, scope: "event-banner-user", identity: session.user.id, limit: 8, windowMs: 60 * 60 * 1000 });
  if (!uploadLimit.allowed) return rateLimitResponse(uploadLimit.retryAfter, "You have uploaded several banners recently. Try again later.");

  const hasReadWriteToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const hasVercelOidcStore = process.env.VERCEL === "1" && Boolean(process.env.BLOB_STORE_ID);
  if (!hasReadWriteToken && !hasVercelOidcStore) {
    return NextResponse.json({ error: "Banner uploads are not configured yet. Add a Vercel Blob store to enable them." }, { status: 503 });
  }

  let file;
  try {
    file = (await request.formData()).get("banner");
  } catch {
    return NextResponse.json({ error: "Choose a valid banner image and try again." }, { status: 400 });
  }
  if (!file || typeof file === "string" || !ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Choose a JPG, PNG, or WebP banner." }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_BANNER_BYTES) {
    return NextResponse.json({ error: "Banner images must be smaller than 4 MB." }, { status: 400 });
  }
  if (!await matchesImageType(file)) {
    return NextResponse.json({ error: "That file does not match its image type. Choose a valid JPG, PNG, or WebP image." }, { status: 400 });
  }

  try {
    const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    const blob = await put(`event-banners/${crypto.randomUUID()}.${extension}`, file, {
      access: "public",
      addRandomSuffix: false,
      contentType: file.type,
    });
    return NextResponse.json({ url: blob.url });
  } catch (error) {
    console.error("Event banner upload failed:", error);
    return NextResponse.json({ error: "We could not upload that banner. Please try again." }, { status: 502 });
  }
}
