import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export async function validatePasswordCredentials(rawEmail, password) {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || typeof password !== "string" || !password) return null;
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      frequentFlyerVerification: { select: { status: true } },
      profile: { select: { fullName: true } },
    },
  });
  if (!user || user.isDeleted || (process.env.NODE_ENV === "production" && user.isDemo)
    || !user.passwordHash || !user.isVerified || user.isSuspended) return null;
  if (user.role === "FREQUENT_FLYER" && user.frequentFlyerVerification
    && user.frequentFlyerVerification.status !== "RECORDS_MATCHED") return null;
  if (!(await bcrypt.compare(password, user.passwordHash))) return null;
  return user;
}

export async function buildSignedInUser(user, method) {
  const previousSignIn = await prisma.adminAction.findFirst({
    where: { adminId: user.id, actionType: "USER_SIGNED_IN" },
    select: { id: true },
  });
  const { logActivity } = await import("@/lib/audit-log");
  await logActivity({
    actorId: user.id,
    targetId: user.id,
    actionType: "USER_SIGNED_IN",
    summary: `${user.role === "ADMIN" ? "Administrator" : "Member"} signed in with ${method}`,
    details: { method, role: user.role, twoFactor: Boolean(user.twoFactorEnabled) },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.profile?.fullName || user.email,
    ...(typeof user.image === "string" && user.image ? { image: user.image } : {}),
    ...(typeof user.googleImage === "string" && user.googleImage ? { googleImage: user.googleImage } : {}),
    role: user.role,
    sessionVersion: user.sessionVersion || 0,
    isFirstSignIn: !previousSignIn,
  };
}
