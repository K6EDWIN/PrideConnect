import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const MAX_BANNER_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_IMAGE_BYTES = 4 * 1024 * 1024;
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

  const uploadLimit = await consumeRateLimit({ request, scope: "event-banner-user", identity: session.user.id, limit: 16, windowMs: 60 * 60 * 1000 });
  if (!uploadLimit.allowed) return rateLimitResponse(uploadLimit.retryAfter, "You have uploaded several event images recently. Try again later.");

  const hasReadWriteToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const hasVercelOidcStore = process.env.VERCEL === "1" && Boolean(process.env.BLOB_STORE_ID);
  if (!hasReadWriteToken && !hasVercelOidcStore) {
    return NextResponse.json({ error: "Banner uploads are not configured yet. Add a Vercel Blob store to enable them." }, { status: 503 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Choose a valid banner image and try again." }, { status: 400 });
  }
  const banner = formData.get("banner");
  const photos = formData.getAll("photos");
  const files = banner && typeof banner !== "string" ? [banner] : photos;
  if (!files.length || files.some((file) => typeof file === "string" || !ALLOWED_TYPES.has(file.type))) {
    return NextResponse.json({ error: "Choose JPG, PNG, or WebP event images." }, { status: 400 });
  }
  if (files.length > 8) return NextResponse.json({ error: "Upload up to eight event photos at a time." }, { status: 400 });
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_IMAGE_BYTES) {
    return NextResponse.json({ error: "Upload event photos one at a time. Each image can be up to 4 MB." }, { status: 413 });
  }
  if (files.some((file) => file.size <= 0 || file.size > MAX_BANNER_BYTES)) {
    return NextResponse.json({ error: "Each event image must be smaller than 4 MB." }, { status: 400 });
  }
  if (!(await Promise.all(files.map(matchesImageType))).every(Boolean)) {
    return NextResponse.json({ error: "An image does not match its file type. Choose valid JPG, PNG, or WebP images." }, { status: 400 });
  }

  const eventId = formData.get("eventId");
  if (typeof eventId === "string" && eventId) {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { createdById: true, isHidden: true } });
    if (!event || event.isHidden) return NextResponse.json({ error: "Event not found." }, { status: 404 });
    if (event.createdById !== session.user.id && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Only the event organiser or an administrator can add event photos." }, { status: 403 });
    }
  }

  try {
    const urls = await Promise.all(files.map(async (file) => {
      const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
      const blob = await put(`event-images/${crypto.randomUUID()}.${extension}`, file, {
        access: "public",
        addRandomSuffix: false,
        contentType: file.type,
      });
      return blob.url;
    }));
    return NextResponse.json(banner && typeof banner !== "string" ? { url: urls[0] } : { urls });
  } catch (error) {
    console.error("Event banner upload failed:", error);
    return NextResponse.json({ error: "We could not upload that banner. Please try again." }, { status: 502 });
  }
}
