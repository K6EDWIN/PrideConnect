import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/account/route";
import { getServerSession } from "next-auth/next";
import { del } from "@vercel/blob";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ logActivity: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    profile: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

describe("DELETE /api/account", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires an authenticated non-admin account", async () => {
    getServerSession.mockResolvedValueOnce(null);
    expect((await DELETE()).status).toBe(401);

    getServerSession.mockResolvedValueOnce({ user: { id: "admin-1", role: "ADMIN" } });
    expect((await DELETE()).status).toBe(403);
  });

  it("anonymizes personal data without deleting the referenced user record", async () => {
    getServerSession.mockResolvedValueOnce({ user: { id: "member-1", role: "STAFF" } });
    prisma.user.findUnique.mockResolvedValueOnce({ id: "member-1", isDeleted: false, role: "STAFF" });
    prisma.profile.findUnique.mockResolvedValueOnce({ avatarUrl: null, coverImageUrl: null });
    const tx = {
      user: { update: vi.fn() },
      profile: { updateMany: vi.fn() },
      profileSkill: { deleteMany: vi.fn() },
      profileInterest: { deleteMany: vi.fn() },
      profileMentorshipTopic: { deleteMany: vi.fn() },
      flightReconnect: { deleteMany: vi.fn() },
      message: { updateMany: vi.fn() },
      feedback: { updateMany: vi.fn() },
      report: { updateMany: vi.fn() },
      opportunity: { deleteMany: vi.fn() },
      event: { deleteMany: vi.fn() },
      verificationToken: { deleteMany: vi.fn() },
      authSession: { deleteMany: vi.fn() },
      notification: { deleteMany: vi.fn() },
    };
    prisma.$transaction.mockImplementationOnce((callback) => callback(tx));

    const response = await DELETE();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(del).not.toHaveBeenCalled();
    expect(data.message).toMatch(/anonymized/i);
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "member-1" },
      data: expect.objectContaining({ isDeleted: true, isSuspended: true, isVerified: false }),
    }));
    expect(tx.profile.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "member-1" },
      data: expect.objectContaining({ fullName: "Deleted member", isPublic: false }),
    }));
    expect(tx.report.updateMany).toHaveBeenCalledWith({ where: { reporterId: "member-1" }, data: { description: null } });
    expect(tx.authSession.deleteMany).toHaveBeenCalledWith({ where: { userId: "member-1" } });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });
});
