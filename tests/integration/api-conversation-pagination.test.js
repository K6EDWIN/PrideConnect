import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/conversations/[id]/messages/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/conversations", () => ({ hasAcceptedRelationship: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

describe("GET /api/conversations/[id]/messages pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerSession.mockResolvedValue({ user: { id: "member-1" } });
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-1", participantOneId: "member-1", participantTwoId: "member-2",
      participantOne: { isDemo: false, isDeleted: false }, participantTwo: { isDemo: false, isDeleted: false },
    });
  });

  it("loads the latest 100 messages and returns a cursor when older messages exist", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: `m-${index}`, createdAt: new Date(index), senderId: "member-2" }));
    prisma.message.findMany.mockResolvedValue(rows.reverse());
    const response = await GET(new Request("https://example.test/api/conversations/conversation-1/messages"), { params: Promise.resolve({ id: "conversation-1" }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(100);
    expect(data.hasMore).toBe(true);
    expect(data.nextCursor).toBe("m-1");
  });

  it("uses a conversation-scoped cursor when loading earlier messages", async () => {
    const cursorDate = new Date("2026-01-02T00:00:00Z");
    prisma.message.findFirst.mockResolvedValue({ id: "cursor-1", createdAt: cursorDate });
    prisma.message.findMany.mockResolvedValue([{ id: "older-1", createdAt: new Date("2026-01-01T00:00:00Z") }]);
    const response = await GET(new Request("https://example.test/api/conversations/conversation-1/messages?before=cursor-1"), { params: Promise.resolve({ id: "conversation-1" }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ conversationId: "conversation-1", OR: expect.any(Array) }),
      take: 101,
    }));
    expect(data.messages[0].id).toBe("older-1");
    expect(data.hasMore).toBe(false);
  });
});
