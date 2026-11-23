import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { logActivity } from "./audit-log";
import { consumeRateLimit } from "@/lib/rate-limit";

export const authOptions = {
  session: {
    strategy: "jwt",
  },
  providers: [
    ...(() => {
      const googleClientId = (process.env.GOOGLE_CLIENT_ID || "")
        .replace(/^["']|["']$/g, "")
        .trim();
      const googleClientSecret = (process.env.GOOGLE_CLIENT_SECRET || "")
        .replace(/^["']|["']$/g, "")
        .trim();

      return googleClientId && googleClientSecret
        ? [GoogleProvider({ clientId: googleClientId, clientSecret: googleClientSecret })]
        : [];
    })(),
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const loginLimit = await consumeRateLimit({ request, scope: "credentials-login-ip", limit: 15, windowMs: 15 * 60 * 1000 });
        if (!loginLimit.allowed) throw new Error("Too many sign-in attempts. Try again later.");
        const email = typeof credentials?.email === "string"
          ? credentials.email.trim().toLowerCase()
          : "";
        if (!email || !credentials?.password) {
          throw new Error("Email and password are required");
        }

        const user = await prisma.user.findUnique({
          where: { email },
          include: { frequentFlyerVerification: { select: { status: true } } },
        });

        if (!user) {
          throw new Error("No account found with that email");
        }
        if (user.isDeleted) {
          throw new Error("This account has been deleted.");
        }

        if (process.env.NODE_ENV === "production" && user.isDemo) {
          throw new Error("Demonstration accounts cannot sign in to the live service.");
        }

        if (!user.passwordHash) {
          throw new Error("This account uses Google sign-in. Continue with Google.");
        }

        const isValid = await bcrypt.compare(
          credentials.password,
          user.passwordHash
        );

        if (!isValid) {
          throw new Error("Incorrect password");
        }

        if (!user.isVerified) {
          throw new Error(
            "Please verify your email before logging in. Check your inbox for the verification link."
          );
        }

        if (user.isSuspended) {
          throw new Error(
            "This account has been suspended. Contact an administrator."
          );
        }

        if (user.role === "FREQUENT_FLYER" && user.frequentFlyerVerification
          && user.frequentFlyerVerification.status !== "RECORDS_MATCHED") {
          throw new Error("Your Asante membership review is pending or could not be confirmed. Contact a PrideConnect administrator.");
        }

        await logActivity({
          actorId: user.id,
          targetId: user.id,
          actionType: "USER_SIGNED_IN",
          summary: `${user.role === "ADMIN" ? "Administrator" : "Member"} signed in with email and password`,
          details: { method: "credentials", role: user.role },
        });

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          sessionVersion: user.sessionVersion || 0,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") {
        if (!user.email || profile?.email_verified !== true) return false;
        const googleEmail = user.email.trim().toLowerCase();

        let existingUser = await prisma.user.findUnique({
          where: { email: googleEmail },
          include: { frequentFlyerVerification: { select: { status: true } } },
        });

        if (!existingUser) return false;
        if (existingUser.isDeleted) return false;
        if (!existingUser.isVerified) return false;

        if (process.env.NODE_ENV === "production" && existingUser.isDemo) {
          return false;
        }

        if (existingUser.isSuspended) {
          return false;
        }

        if (existingUser.role === "FREQUENT_FLYER" && existingUser.frequentFlyerVerification
          && existingUser.frequentFlyerVerification.status !== "RECORDS_MATCHED") {
          return false;
        }

        user.id = existingUser.id;
        user.role = existingUser.role;
        user.sessionVersion = existingUser.sessionVersion || 0;
        await logActivity({
          actorId: existingUser.id,
          targetId: existingUser.id,
          actionType: "USER_SIGNED_IN",
          summary: `${existingUser.role === "ADMIN" ? "Administrator" : "Member"} signed in with Google`,
          details: { method: "google", role: existingUser.role },
        });
        return true;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.sessionVersion = user.sessionVersion || 0;
        token.isSuspended = Boolean(user.isSuspended);
        token.isDeleted = Boolean(user.isDeleted);
      }

      // Check database for active suspension status on existing session tokens
      if (token?.id) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id },
            select: { isSuspended: true, isDemo: true, isDeleted: true, role: true, passwordChangedAt: true, sessionVersion: true },
          });

          if (dbUser) {
            token.isSuspended = dbUser.isSuspended;
            token.isDemo = dbUser.isDemo;
            token.isDeleted = dbUser.isDeleted;
            token.role = dbUser.role;
            token.passwordResetRequired = Boolean(
              (token.sessionVersion ?? 0) !== (dbUser.sessionVersion ?? 0)
              || (dbUser.passwordChangedAt && token.iat && token.iat * 1000 < dbUser.passwordChangedAt.getTime())
            );
          } else {
            token.isSuspended = true;
          }
        } catch {
          // Fallback gracefully on transient DB connection issues
        }
      }

      return token;
    },
    async session({ session, token }) {
      // Immediately invalidate session if the account has been suspended by an admin
      if (token?.isSuspended || token?.isDeleted || token?.passwordResetRequired || (process.env.NODE_ENV === "production" && token?.isDemo)) {
        return null;
      }

      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
        session.user.isSuspended = token.isSuspended || false;
      }
      return session;
    },
  },
  events: {
    async signOut({ token }) {
      if (!token?.id) return;
      await logActivity({
        actorId: token.id,
        targetId: token.id,
        actionType: "USER_SIGNED_OUT",
        summary: "Signed out of PrideConnect",
        details: {},
      });
    },
  },
  pages: {
    signIn: "/login",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
