import { del, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function matchesImageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.type === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (file.type === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

function validGooglePhotoUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"));
  } catch {
    return false;
  }
}

function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
    || (process.env.VERCEL === "1" && Boolean(process.env.BLOB_STORE_ID));
}

function isOwnedVercelBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "blob.vercel-storage.com" || url.hostname.endsWith(".blob.vercel-storage.com"));
  } catch {
    return false;
  }
}

async function getProfile(session) {
  return prisma.profile.findUnique({
    where: { userId: session.user.id },
    select: { id: true, avatarUrl: true, coverImageUrl: true, coverPositionX: true, coverPositionY: true },
  });
}

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const limit = await consumeRateLimit({ request, scope: "profile-image-user", identity: session.user.id, limit: 12, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) return rateLimitResponse(limit.retryAfter, "You have changed profile images several times recently. Try again later.");
  if (!blobConfigured()) return NextResponse.json({ error: "Profile image storage is not configured yet. Connect a Vercel Blob store to enable uploads." }, { status: 503 });

  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Choose an image and try again." }, { status: 400 });
  }
  const kind = form.get("kind");
  const file = form.get("image");
  if (!["avatar", "cover"].includes(kind)) return NextResponse.json({ error: "Choose a profile photo or cover banner." }, { status: 400 });
  if (!file || typeof file === "string" || !ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Choose a JPG, PNG, or WebP image." }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "Images must be smaller than 5 MB." }, { status: 400 });
  if (!await matchesImageType(file)) return NextResponse.json({ error: "That file does not match its image type. Choose a valid JPG, PNG, or WebP image." }, { status: 400 });

  const profile = await getProfile(session);
  if (!profile) return NextResponse.json({ error: "Profile not found. Reload your profile and try again." }, { status: 404 });

  let positionX = profile.coverPositionX;
  let positionY = profile.coverPositionY;
  if (kind === "cover") {
    const x = Number(form.get("positionX"));
    const y = Number(form.get("positionY"));
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 100 || y < 0 || y > 100) {
      return NextResponse.json({ error: "Banner position must be a value between 0 and 100." }, { status: 400 });
    }
    positionX = x;
    positionY = y;
  }

  let uploaded;
  try {
    const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    uploaded = await put(`profile-images/${session.user.id}/${kind}/${crypto.randomUUID()}.${extension}`, file, {
      access: "public",
      addRandomSuffix: false,
      contentType: file.type,
    });
    const updated = await prisma.profile.update({
      where: { userId: session.user.id },
      data: kind === "avatar"
        ? { avatarUrl: uploaded.url }
        : { coverImageUrl: uploaded.url, coverPositionX: positionX, coverPositionY: positionY },
      select: { avatarUrl: true, coverImageUrl: true, coverPositionX: true, coverPositionY: true },
    });
    const previousUrl = kind === "avatar" ? profile.avatarUrl : profile.coverImageUrl;
    if (previousUrl && previousUrl !== uploaded.url && isOwnedVercelBlobUrl(previousUrl)) {
      try { await del(previousUrl); } catch { /* Replaced image remains harmless if storage cleanup is delayed. */ }
    }
    return NextResponse.json({ profile: updated }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (uploaded?.url) {
      try { await del(uploaded.url); } catch { /* Best-effort cleanup after a failed database write. */ }
    }
    console.error("Profile image update failed:", error);
    return NextResponse.json({ error: "We could not save that image. Please try again." }, { status: 502 });
  }
}

export async function PUT(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || body.kind !== "avatar" || body.source !== "google" || !validGooglePhotoUrl(body.url)
    || body.url !== session.user.googleImage) {
    return NextResponse.json({ error: "That Google profile photo could not be verified. Sign in with Google again and retry." }, { status: 400 });
  }
  const profile = await getProfile(session);
  if (!profile) return NextResponse.json({ error: "Profile not found. Reload your profile and try again." }, { status: 404 });
  const updated = await prisma.profile.update({
    where: { userId: session.user.id },
    data: { avatarUrl: body.url },
    select: { avatarUrl: true, coverImageUrl: true, coverPositionX: true, coverPositionY: true },
  });
  if (profile.avatarUrl && profile.avatarUrl !== body.url && isOwnedVercelBlobUrl(profile.avatarUrl)) {
    try { await del(profile.avatarUrl); } catch { /* Keep profile update successful if old image cleanup is delayed. */ }
  }
  return NextResponse.json({ profile: updated }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const x = Number(body?.positionX);
  const y = Number(body?.positionY);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    return NextResponse.json({ error: "Banner position must be a value between 0 and 100." }, { status: 400 });
  }
  const profile = await prisma.profile.findUnique({ where: { userId: session.user.id }, select: { coverImageUrl: true } });
  if (!profile?.coverImageUrl) return NextResponse.json({ error: "Upload a cover banner before adjusting its position." }, { status: 400 });
  const updated = await prisma.profile.update({
    where: { userId: session.user.id },
    data: { coverPositionX: x, coverPositionY: y },
    select: { avatarUrl: true, coverImageUrl: true, coverPositionX: true, coverPositionY: true },
  });
  return NextResponse.json({ profile: updated }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || !["avatar", "cover"].includes(body.kind)) return NextResponse.json({ error: "Choose a profile photo or cover banner to remove." }, { status: 400 });
  const profile = await getProfile(session);
  if (!profile) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  const oldUrl = body.kind === "avatar" ? profile.avatarUrl : profile.coverImageUrl;
  const updated = await prisma.profile.update({
    where: { userId: session.user.id },
    data: body.kind === "avatar"
      ? { avatarUrl: null }
      : { coverImageUrl: null, coverPositionX: 50, coverPositionY: 50 },
    select: { avatarUrl: true, coverImageUrl: true, coverPositionX: true, coverPositionY: true },
  });
  if (oldUrl && isOwnedVercelBlobUrl(oldUrl) && blobConfigured()) {
    try { await del(oldUrl); } catch { /* The account no longer references the image; cleanup can be retried. */ }
  }
  return NextResponse.json({ profile: updated }, { headers: { "Cache-Control": "no-store" } });
}
