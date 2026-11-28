import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "@/app/api/connection-requests/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    connectionRequest: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    profile: {
      findUnique: vi.fn(),
    },
    mentorshipRequest: {
      findMany: vi.fn(),
    },
  },
}));

describe("/api/connection-requests API Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mentorshipRequest.findMany.mockResolvedValue([]);
    prisma.connectionRequest.findMany.mockResolvedValue([]);
  });

  describe("GET", () => {
    it("returns 401 when unauthenticated", async () => {
      getServerSession.mockResolvedValueOnce(null);

      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data.error).toBe("Not authenticated");
    });

    it("returns sent and received connection requests for logged in user", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "user-me" },
      });

      const mockSent = [{ id: "req-1", receiverId: "user-other", status: "PENDING" }];
      const mockReceived = [{ id: "req-2", senderId: "user-someone", status: "ACCEPTED" }];

      prisma.connectionRequest.findMany
        .mockResolvedValueOnce(mockSent)
        .mockResolvedValueOnce(mockReceived);

      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.sent).toEqual(mockSent);
      expect(data.received).toEqual(mockReceived);
    });
  });

  describe("POST", () => {
    it("returns 401 when unauthenticated", async () => {
      getServerSession.mockResolvedValueOnce(null);

      const req = new Request("http://localhost:3000/api/connection-requests", {
        method: "POST",
        body: JSON.stringify({ receiverId: "user-other" }),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data.error).toBe("Not authenticated");
    });

    it("returns 400 when receiverId is missing", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "user-me" },
      });

      const req = new Request("http://localhost:3000/api/connection-requests", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe("receiverId is required");
    });

    it("returns 400 when attempting to send request to oneself", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "user-me" },
      });

      const req = new Request("http://localhost:3000/api/connection-requests", {
        method: "POST",
        body: JSON.stringify({ receiverId: "user-me" }),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe("You can't send a request to yourself");
    });

    it("returns 404 if recipient user does not exist", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "user-me" },
      });
      prisma.user.findUnique.mockResolvedValueOnce(null);

      const req = new Request("http://localhost:3000/api/connection-requests", {
        method: "POST",
        body: JSON.stringify({ receiverId: "non-existent-user" }),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.error).toBe("Recipient not found");
    });

    it("returns the existing pending request without creating a duplicate", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "user-me" },
      });
      prisma.user.findUnique.mockResolvedValueOnce({ id: "user-target" });
      const existing = {
        id: "existing-req",
        senderId: "user-me",
        receiverId: "user-target",
        status: "PENDING",
      };
      prisma.connectionRequest.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing);

      const req = new Request("http://localhost:3000/api/connection-requests", {
        method: "POST",
        body: JSON.stringify({ receiverId: "user-target" }),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({ connectionRequest: existing, requestPending: true });
      expect(prisma.connectionRequest.create).not.toHaveBeenCalled();
    });

    it("creates and returns the connection request with status 201 on success", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "user-me" },
      });
      prisma.user.findUnique.mockResolvedValueOnce({ id: "user-target" });
      prisma.connectionRequest.findFirst.mockResolvedValueOnce(null);
      const createdRecord = {
        id: "new-req-id",
        senderId: "user-me",
        receiverId: "user-target",
        status: "PENDING",
      };
      prisma.connectionRequest.create.mockResolvedValueOnce(createdRecord);

      const req = new Request("http://localhost:3000/api/connection-requests", {
        method: "POST",
        body: JSON.stringify({ receiverId: "user-target" }),
      });
      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(201);
      expect(data.connectionRequest).toEqual(createdRecord);
    });
  });
});
