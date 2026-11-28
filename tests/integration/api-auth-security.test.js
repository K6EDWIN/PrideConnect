import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/register/route";
import { authOptions } from "@/lib/auth";
import { GET as getAdminStats } from "@/app/api/admin/stats/route";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/gmail", () => ({
  GMAIL_SENDER: "strathtank@gmail.com",
  sendAppEmail: vi.fn().mockResolvedValue({ messageId: "mock-email-id" }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    verificationToken: {
      create: vi.fn(),
    },
    mentorshipRequest: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    connectionRequest: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    event: {
      count: vi.fn().mockResolvedValue(0),
    },
    opportunity: {
      count: vi.fn().mockResolvedValue(0),
    },
    adminAction: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "mock-audit-id" }),
    },
    rateLimitBucket: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

describe("Authentication Hardening & Role Authorization Security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ count: 1, windowStartedAt: new Date() }]);
    prisma.rateLimitBucket.deleteMany.mockResolvedValue({ count: 0 });
  });

  describe("POST /api/register - Role Whitelisting & Input Validation", () => {
    it("rate limits repeated registration attempts from one address", async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 11, windowStartedAt: new Date() }]);
      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new@example.com", password: "password1234", fullName: "New Member", role: "STAFF" }),
      });
      const response = await POST(req);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBeTruthy();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("strictly rejects registration requests attempting to claim ADMIN role", async () => {
      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "attacker@kenya-airways.com",
          password: "password1234",
          fullName: "Malicious Actor",
          role: "ADMIN",
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/Invalid role selected/i);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("rejects registration requests with unrecognized or arbitrary role strings", async () => {
      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "tester@kenya-airways.com",
          password: "password1234",
          fullName: "Test User",
          role: "SUPER_ADMIN_ROOT",
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/Invalid role selected/i);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("rejects invalid email formats", async () => {
      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "not-an-email",
          password: "password1234",
          fullName: "Valid Name",
          role: "STAFF",
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/valid email address/i);
    });

    it("rejects passwords shorter than 8 characters", async () => {
      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "pilot@kenya-airways.com",
          password: "short",
          fullName: "Capt. Alice",
          role: "STAFF",
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toMatch(/at least 8 characters/i);
    });

    it("successfully registers allowed stakeholder roles without exposing verification token", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce({
        id: "user-new-staff",
        email: "firstofficer@kenya-airways.com",
        passwordHash: "$2a$10$mockHashedPassword",
        role: "STAFF",
        isVerified: false,
        isSuspended: false,
        profile: { fullName: "First Officer Brian" },
      });
      prisma.verificationToken.create.mockResolvedValueOnce({
        id: "token-row-id",
        token: "secure-random-token",
      });

      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "firstofficer@kenya-airways.com",
          password: "securePassword123",
          fullName: "First Officer Brian",
          role: "STAFF",
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(202);
      expect(data.message).toMatch(/if this address can be registered/i);
      expect(data.user).toBeUndefined();
      expect(data.token).toBeUndefined(); // Verification token is NOT leaked in response
    });

    it("returns the same public response for an existing email without exposing account state", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: "existing-member" });
      const req = new Request("http://localhost:3000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "existing@example.com", password: "securePassword123", fullName: "Existing Member", role: "STAFF" }),
      });
      const response = await POST(req);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        message: "If this address can be registered, verification instructions will be sent. If you already have an account, sign in or request a fresh verification link.",
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.verificationToken.create).not.toHaveBeenCalled();
    });
  });

  describe("Suspended Account Enforcement in NextAuth", () => {
    it("greets the first credentials sign-in and returning sign-ins by profile name", async () => {
      const credentialsProvider = authOptions.providers.find((p) => p.name === "Credentials");
      prisma.user.findUnique.mockResolvedValue({
        id: "welcome-member",
        email: "member@example.com",
        passwordHash: await bcrypt.hash("validpassword", 10),
        isVerified: true,
        isSuspended: false,
        isDeleted: false,
        isDemo: false,
        role: "STAFF",
        sessionVersion: 0,
        profile: { fullName: "Edwin Kamau" },
      });
      prisma.adminAction.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "prior-sign-in" });

      const firstSignIn = await credentialsProvider.options.authorize({ email: "member@example.com", password: "validpassword" });
      const returningSignIn = await credentialsProvider.options.authorize({ email: "member@example.com", password: "validpassword" });

      expect(firstSignIn).toMatchObject({ name: "Edwin Kamau", isFirstSignIn: true });
      expect(returningSignIn).toMatchObject({ name: "Edwin Kamau", isFirstSignIn: false });
    });

    it("rate limits repeated credentials sign-in attempts by address", async () => {
      const credentialsProvider = authOptions.providers.find((p) => p.name === "Credentials");
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 16, windowStartedAt: new Date() }]);
      await expect(credentialsProvider.options.authorize({ email: "member@example.com", password: "bad-password" }))
        .rejects.toThrow(/Too many sign-in attempts/i);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it.each(["STAFF", "ADMIN"])("does not issue a session to a 2FA-enabled %s account from password-only credentials", async (role) => {
      const credentialsProvider = authOptions.providers.find((p) => p.name === "Credentials");
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "protected-member",
        email: "protected@example.com",
        passwordHash: await bcrypt.hash("validpassword", 10),
        isVerified: true,
        isSuspended: false,
        isDeleted: false,
        isDemo: false,
        role,
        twoFactorEnabled: true,
        twoFactorMethod: "AUTHENTICATOR",
        profile: { fullName: "Protected Member" },
      });

      await expect(credentialsProvider.options.authorize({ email: "protected@example.com", password: "validpassword" }))
        .rejects.toThrow(/second verification step/i);
      expect(prisma.adminAction.findFirst).not.toHaveBeenCalled();
    });

    it("blocks Frequent Flyer sign-in while a membership review is pending", async () => {
      const credentialsProvider = authOptions.providers.find((p) => p.name === "Credentials");
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "pending-flyer",
        email: "flyer@example.com",
        passwordHash: await bcrypt.hash("validpassword", 10),
        isVerified: true,
        isSuspended: false,
        isDeleted: false,
        isDemo: false,
        role: "FREQUENT_FLYER",
        frequentFlyerVerification: { status: "PENDING" },
      });

      await expect(credentialsProvider.options.authorize({ email: "flyer@example.com", password: "validpassword" }))
        .rejects.toThrow(/unable to sign in with those credentials/i);
    });

    it("rejects Credentials login when account is suspended (isSuspended: true)", async () => {
      const credentialsProvider = authOptions.providers.find(
        (p) => p.name === "Credentials"
      );

      const hashedPassword = await bcrypt.hash("validpassword", 10);
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "suspended-user-id",
        email: "suspended@kenya-airways.com",
        passwordHash: hashedPassword,
        isVerified: true,
        isSuspended: true,
        role: "STAFF",
      });

      const rawAuthorize = credentialsProvider.options?.authorize;
      if (rawAuthorize) {
        await expect(
          rawAuthorize({
            email: "suspended@kenya-airways.com",
            password: "validpassword",
          })
        ).rejects.toThrow(/unable to sign in with those credentials/i);
      } else {
        const result = await credentialsProvider.authorize({
          email: "suspended@kenya-airways.com",
          password: "validpassword",
        });
        expect(result).toBeNull();
      }
    });

    it("rejects Google OAuth sign-in when account is suspended (isSuspended: true)", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "suspended-google-user",
        email: "googleuser@kenya-airways.com",
        isVerified: true,
        isSuspended: true,
        role: "ALUMNI",
      });

      const result = await authOptions.callbacks.signIn({
        user: { email: "googleuser@kenya-airways.com" },
        account: { provider: "google" },
        profile: { email_verified: true },
      });

      expect(result).toBe(false);
    });

    it("rejects Google OAuth sign-in for an anonymized account", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "deleted-google-user",
        email: "deleted@account.invalid",
        isDeleted: true,
        isSuspended: true,
        role: "STAFF",
      });

      const result = await authOptions.callbacks.signIn({
        user: { email: "deleted@account.invalid" },
        account: { provider: "google" },
        profile: { email_verified: true },
      });

      expect(result).toBe(false);
    });

    it("does not create a trusted account for an unregistered Google identity", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      const result = await authOptions.callbacks.signIn({
        user: { email: "new-member@example.com" },
        account: { provider: "google" },
        profile: { email_verified: true },
      });

      expect(result).toBe(false);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("invalidates an existing JWT when its account is deleted", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        isDeleted: true,
        isSuspended: true,
        role: "STAFF",
      });

      const token = await authOptions.callbacks.jwt({
        token: { id: "deleted-user", role: "STAFF", isDeleted: false, isSuspended: false },
      });

      expect(token.isDeleted).toBe(true);
      expect(await authOptions.callbacks.session({
        session: { user: { name: "Deleted member" } },
        token,
      })).toBeNull();
    });

    it("invalidates active JWT sessions when user becomes suspended in database", async () => {
      // User is marked as suspended in DB during active session
      prisma.user.findUnique.mockResolvedValueOnce({
        isSuspended: true,
        role: "STAFF",
      });

      const token = await authOptions.callbacks.jwt({
        token: { id: "active-session-user", role: "STAFF", isSuspended: false },
      });

      expect(token.isSuspended).toBe(true);

      // Session callback must return null to terminate the session
      const session = await authOptions.callbacks.session({
        session: { user: { name: "Suspended Staff" } },
        token,
      });

      expect(session).toBeNull();
    });

    it("invalidates sessions issued before a password reset", async () => {
      prisma.user.findUnique.mockReset();
      const passwordChangedAt = new Date();
      prisma.user.findUnique.mockResolvedValueOnce({
        isSuspended: false,
        isDemo: false,
        isDeleted: false,
        role: "STAFF",
        passwordChangedAt,
      });
      const token = await authOptions.callbacks.jwt({
        token: { id: "reset-member", role: "STAFF", iat: Math.floor((passwordChangedAt.getTime() - 60_000) / 1000) },
      });

      expect(token.passwordResetRequired).toBe(true);
      const session = await authOptions.callbacks.session({
        session: { user: { name: "Member" } },
        token,
      });
      expect(session).toBeNull();
    });

    it("allows active sessions to continue when user is not suspended", async () => {
      prisma.user.findUnique.mockReset();
      prisma.user.findUnique.mockResolvedValue({
        id: "active-valid-user",
        isSuspended: false,
        role: "STAFF",
      });

      const token = await authOptions.callbacks.jwt({
        token: { id: "active-valid-user", role: "STAFF", isSuspended: false },
      });

      expect(token.isSuspended).toBe(false);

      const session = await authOptions.callbacks.session({
        session: { user: { name: "Active Staff" } },
        token,
      });

      expect(session).not.toBeNull();
      expect(session.user.id).toBe("active-valid-user");
      expect(session.user.role).toBe("STAFF");
      expect(session.user.isSuspended).toBe(false);
    });

    it("exposes the profile name and first-sign-in flag to the client session", async () => {
      const session = await authOptions.callbacks.session({
        session: { user: { email: "member@example.com" } },
        token: {
          id: "new-member",
          name: "Edwin Kamau",
          role: "STAFF",
          isFirstSignIn: true,
          isSuspended: false,
          isDeleted: false,
        },
      });

      expect(session.user.name).toBe("Edwin Kamau");
      expect(session.user.isFirstSignIn).toBe(true);
    });
  });

  describe("Admin Route Authorization Guards", () => {
    it("rejects non-admin roles (e.g. STAFF) from accessing /api/admin/stats with 403", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "staff-member-id", role: "STAFF" },
      });

      const res = await getAdminStats();
      const data = await res.json();

      expect(res.status).toBe(403);
      expect(data.error).toBe("Admins only");
    });

    it("allows users with verified role ADMIN to access /api/admin/stats with 200", async () => {
      getServerSession.mockResolvedValueOnce({
        user: { id: "admin-user-id", role: "ADMIN" },
      });

      prisma.user.count.mockResolvedValue(10);

      const res = await getAdminStats();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.totalUsers).toBe(10);
    });
  });
});
