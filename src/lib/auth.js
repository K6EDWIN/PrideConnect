import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { prisma } from "./prisma";
import { logActivity } from "./audit-log";
import { consumeRateLimit } from "@/lib/rate-limit";
import { validatePasswordCredentials, buildSignedInUser } from "@/lib/password-auth";
import { createTwoFactorChallenge, getActiveChallenge, verifyChallengeCode } from "@/lib/two-factor-challenges";
import { buildAppUrl } from "@/lib/app-url";
import { createGooglePhotoProof, verifyGooglePhotoProof } from "@/lib/google-photo-proof";

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
        twoFactorToken: { label: "Verification challenge", type: "text" },
        twoFactorCode: { label: "Verification code", type: "text" },
        googlePhoto: { label: "Google profile photo", type: "text" },
        googlePhotoProof: { label: "Google profile photo proof", type: "text" },
      },
      async authorize(credentials, request) {
        const genericFailure = "Unable to sign in with those credentials. Check your details or use account recovery.";
        const loginLimit = await consumeRateLimit({ request, scope: "credentials-login-ip", limit: 15, windowMs: 15 * 60 * 1000 });
        if (!loginLimit.allowed) throw new Error("Too many sign-in attempts. Try again later.");
        let user;
        if (credentials?.twoFactorToken) {
          const challenge = await getActiveChallenge(credentials.twoFactorToken, "LOGIN");
          if (!challenge || !challenge.user.twoFactorEnabled || challenge.user.isDeleted || challenge.user.isSuspended || !challenge.user.isVerified
            || (process.env.NODE_ENV === "production" && challenge.user.isDemo)
            || (challenge.user.role === "FREQUENT_FLYER" && challenge.user.frequentFlyerVerification
              && challenge.user.frequentFlyerVerification.status !== "RECORDS_MATCHED")) {
            throw new Error("The verification request is invalid or expired. Sign in again.");
          }
          user = await verifyChallengeCode(challenge, credentials?.twoFactorCode);
        if (user && verifyGooglePhotoProof(credentials.twoFactorToken, credentials?.googlePhoto, credentials?.googlePhotoProof)) {
            user.image = credentials.googlePhoto;
            user.googleImage = credentials.googlePhoto;
          }
        } else {
          user = await validatePasswordCredentials(credentials?.email, credentials?.password);
        }
        if (!user) throw new Error(genericFailure);

        if (user.twoFactorEnabled && !credentials?.twoFactorToken) {
          throw new Error("Complete the second verification step before signing in.");
        } else if (!user.twoFactorEnabled && (credentials?.twoFactorToken || credentials?.twoFactorCode)) {
          throw new Error(genericFailure);
        }

        return buildSignedInUser(user, credentials?.twoFactorToken ? "two-factor verification" : "email and password");
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
          include: {
            frequentFlyerVerification: { select: { status: true } },
            profile: { select: { fullName: true } },
          },
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

        if (existingUser.twoFactorEnabled) {
          try {
            const challenge = await createTwoFactorChallenge({ user: existingUser, purpose: "LOGIN" });
            const loginUrl = new URL(buildAppUrl("/login"));
            const params = new URLSearchParams({ twoFactorToken: challenge.token, method: existingUser.twoFactorMethod || "AUTHENTICATOR" });
            const photoProof = createGooglePhotoProof(challenge.token, user.image);
            if (photoProof) {
              params.set("googlePhoto", user.image);
              params.set("googlePhotoProof", photoProof);
            }
            loginUrl.hash = params.toString();
            return loginUrl.toString();
          } catch {
            return false;
          }
        }

        user.id = existingUser.id;
        user.name = existingUser.profile?.fullName || user.name || existingUser.email;
        user.role = existingUser.role;
        user.sessionVersion = existingUser.sessionVersion || 0;
        const previousSignIn = await prisma.adminAction.findFirst({
          where: { adminId: existingUser.id, actionType: "USER_SIGNED_IN" },
          select: { id: true },
        });
        user.isFirstSignIn = !previousSignIn;
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
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id;
        token.name = user.name || user.email;
        token.role = user.role;
        token.sessionVersion = user.sessionVersion || 0;
        token.isSuspended = Boolean(user.isSuspended);
        token.isDeleted = Boolean(user.isDeleted);
        token.isFirstSignIn = Boolean(user.isFirstSignIn);
        if (Object.hasOwn(user, "image")) token.picture = user.image || null;
        if (typeof user.googleImage === "string") token.googleImage = user.googleImage;
        else if (account?.provider === "google" && typeof user.image === "string") token.googleImage = user.image;
      }

      // Check database for active suspension status on existing session tokens
      if (token?.id) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id },
            select: { isSuspended: true, isDemo: true, isDeleted: true, role: true, passwordChangedAt: true, sessionVersion: true, profile: { select: { avatarUrl: true } } },
          });

          if (dbUser) {
            token.isSuspended = dbUser.isSuspended;
            token.isDemo = dbUser.isDemo;
            token.isDeleted = dbUser.isDeleted;
            token.role = dbUser.role;
            token.picture = dbUser.profile?.avatarUrl || token.googleImage || null;
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
        session.user.name = token.name || session.user.name || session.user.email;
        session.user.role = token.role;
        session.user.isSuspended = token.isSuspended || false;
        session.user.isFirstSignIn = Boolean(token.isFirstSignIn);
        session.user.image = token.picture || null;
        session.user.googleImage = token.googleImage || null;
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
