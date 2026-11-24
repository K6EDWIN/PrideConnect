import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "@/app/api/profile/route";
import { PATCH as patchConnectionRequest } from "@/app/api/connection-requests/[id]/route";
import { PATCH as patchAdminUser } from "@/app/api/admin/users/[id]/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/conversations", () => ({ ensureConversation: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    profile: { findUnique: vi.fn() },
    connectionRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    adminAction: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

function profileRequest(body) {
  return new Request("http://localhost:3000/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/profile validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for a malformed profile JSON body", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    const response = await PUT(new Request("http://localhost:3000/api/profile", { method: "PUT", body: "{" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON request body");
  });

  it("returns 400 for malformed connection-request JSON", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    const response = await patchConnectionRequest(new Request("http://localhost:3000/api/connection-requests/request-1", { method: "PATCH", body: "{" }), { params: Promise.resolve({ id: "request-1" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON request body");
  });

  it("returns 400 for malformed administrator action JSON", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "admin-1", role: "ADMIN" } });
    const response = await patchAdminUser(new Request("http://localhost:3000/api/admin/users/member-1", { method: "PATCH", body: "{" }), { params: Promise.resolve({ id: "member-1" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON request body");
  });

  it("requires a full name", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    const response = await PUT(profileRequest({ fullName: "" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/full name must contain/i);
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
  });

  it("rejects skill, interest, and topic selections that are not arrays of string identifiers", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    const response = await PUT(profileRequest({ fullName: "Member", skillIds: ["skill-1", 42] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Profile selections must be arrays of identifiers");
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
  });

  it("rejects oversized profile text before database writes", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    const response = await PUT(profileRequest({ fullName: "Member Name", bio: "x".repeat(2001) }));
    expect(response.status).toBe(400);
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
  });

  it("rejects unexpected properties instead of silently ignoring them", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    const response = await PUT(profileRequest({ fullName: "Member Name", isAdmin: true }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/unsupported fields/i);
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
  });
});
