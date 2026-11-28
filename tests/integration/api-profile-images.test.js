import { beforeEach, describe, expect, it, vi } from "vitest";
import { File } from "node:buffer";
import { DELETE, PATCH, POST, PUT } from "@/app/api/profile/images/route";
import { getServerSession } from "next-auth/next";
import { del, put } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { profile: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(),
  rateLimitResponse: vi.fn((retryAfter, message) => Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfter) } })),
}));

const existingProfile = {
  id: "profile-1",
  avatarUrl: null,
  coverImageUrl: null,
  coverPositionX: 50,
  coverPositionY: 50,
};

function imageRequest(kind = "cover", overrides = {}) {
  const form = new FormData();
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  form.set("kind", kind);
  form.set("image", new File([signature], "profile.png", { type: "image/png" }));
  if (kind === "cover") {
    form.set("positionX", String(overrides.positionX ?? 50));
    form.set("positionY", String(overrides.positionY ?? 50));
  }
  return new Request("https://prideconnect.example/api/profile/images", { method: "POST", body: form });
}

describe("profile image persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_STORE_ID", "test-profile-store");
    getServerSession.mockResolvedValue({ user: { id: "member-1", googleImage: "https://lh3.googleusercontent.com/photo" } });
    consumeRateLimit.mockResolvedValue({ allowed: true, retryAfter: 60 });
    prisma.profile.findUnique.mockResolvedValue(existingProfile);
    prisma.profile.update.mockResolvedValue({ ...existingProfile, coverImageUrl: "https://profile.public.blob.vercel-storage.com/cover.webp", coverPositionX: 35, coverPositionY: 65 });
    put.mockResolvedValue({ url: "https://profile.public.blob.vercel-storage.com/cover.webp" });
    del.mockResolvedValue(undefined);
  });

  it("requires an authenticated owner before accepting an upload", async () => {
    getServerSession.mockResolvedValueOnce(null);
    const response = await POST(imageRequest());
    expect(response.status).toBe(401);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects image bytes that do not match the declared type", async () => {
    const form = new FormData();
    form.set("kind", "cover");
    form.set("positionX", "50");
    form.set("positionY", "50");
    form.set("image", new File(["not an image"], "cover.png", { type: "image/png" }));
    const response = await POST(new Request("https://prideconnect.example/api/profile/images", { method: "POST", body: form }));
    expect(response.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("stores a cover image and its crop position against the signed-in profile", async () => {
    const response = await POST(imageRequest("cover", { positionX: 35, positionY: 65 }));
    expect(response.status).toBe(200);
    expect(prisma.profile.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "member-1" },
      data: { coverImageUrl: "https://profile.public.blob.vercel-storage.com/cover.webp", coverPositionX: 35, coverPositionY: 65 },
    }));
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^profile-images\/member-1\/cover\//), expect.any(File), expect.objectContaining({ access: "public" }));
  });

  it("only persists the Google photo attached to the authenticated session", async () => {
    const accepted = await PUT(new Request("https://prideconnect.example/api/profile/images", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "avatar", source: "google", url: "https://lh3.googleusercontent.com/photo" }),
    }));
    expect(accepted.status).toBe(200);

    const rejected = await PUT(new Request("https://prideconnect.example/api/profile/images", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "avatar", source: "google", url: "https://attacker.example/photo.png" }),
    }));
    expect(rejected.status).toBe(400);
  });

  it("validates saved positions and removes the selected banner independently", async () => {
    const invalidPosition = await PATCH(new Request("https://prideconnect.example/api/profile/images", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positionX: 101, positionY: 50 }),
    }));
    expect(invalidPosition.status).toBe(400);

    prisma.profile.findUnique.mockResolvedValueOnce({ ...existingProfile, coverImageUrl: "https://profile.public.blob.vercel-storage.com/cover.webp" });
    const removed = await DELETE(new Request("https://prideconnect.example/api/profile/images", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "cover" }),
    }));
    expect(removed.status).toBe(200);
    expect(prisma.profile.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { coverImageUrl: null, coverPositionX: 50, coverPositionY: 50 },
    }));
    expect(del).toHaveBeenCalledWith("https://profile.public.blob.vercel-storage.com/cover.webp");
  });
});
