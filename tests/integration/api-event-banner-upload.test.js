import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { File } from "node:buffer";
import { POST } from "@/app/api/events/banner/route";
import { getServerSession } from "next-auth/next";
import { put } from "@vercel/blob";
import { consumeRateLimit } from "@/lib/rate-limit";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@vercel/blob", () => ({ put: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 60 }),
  rateLimitResponse: vi.fn((retryAfter, message) => Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfter) } })),
}));

function uploadRequest(file) {
  const form = new FormData();
  form.set("banner", file);
  return new Request("https://prideconnect.example/api/events/banner", { method: "POST", body: form });
}

describe("POST /api/events/banner", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_STORE_ID", "preview-store");
    getServerSession.mockResolvedValue({ user: { id: "member-1" } });
    consumeRateLimit.mockResolvedValue({ allowed: true, retryAfter: 60 });
    put.mockResolvedValue({ url: "https://preview.public.blob.vercel-storage.com/banner.png" });
  });

  it("rejects unauthenticated uploads before using storage", async () => {
    getServerSession.mockResolvedValueOnce(null);
    const response = await POST(uploadRequest(new File(["not-used"], "banner.png", { type: "image/png" })));
    expect(response.status).toBe(401);
    expect(consumeRateLimit).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("enforces the per-member upload limit", async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });
    const response = await POST(uploadRequest(new File(["not-used"], "banner.png", { type: "image/png" })));
    expect(response.status).toBe(429);
    expect(consumeRateLimit).toHaveBeenCalledWith(expect.objectContaining({ scope: "event-banner-user", identity: "member-1", limit: 16 }));
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a PNG MIME claim when the file signature is not PNG", async () => {
    const response = await POST(uploadRequest(new File(["not a png"], "banner.png", { type: "image/png" })));
    expect(response.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("accepts a valid PNG through the configured Vercel Blob store", async () => {
    const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const response = await POST(uploadRequest(new File([signature], "banner.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    expect((await response.json()).url).toMatch(/public\.blob\.vercel-storage\.com/);
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^event-images\//), expect.any(File), expect.objectContaining({ access: "public", contentType: "image/png" }));
  });
});
