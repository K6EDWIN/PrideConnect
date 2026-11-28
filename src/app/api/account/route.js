import { randomBytes, randomUUID } from "node:crypto";
import { del } from "@vercel/blob";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (session.user.role === "ADMIN") {
    return NextResponse.json({ error: "Administrator accounts cannot be deleted here" }, { status: 403 });
  }

  const userId = session.user.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isDeleted: true, role: true },
  });
  if (!user || user.isDeleted) {
    return NextResponse.json({ error: "Account is already unavailable" }, { status: 404 });
  }
  const profileImages = await prisma.profile.findUnique({
    where: { userId },
    select: { avatarUrl: true, coverImageUrl: true },
  });
  const replacementPasswordHash = await bcrypt.hash(randomBytes(48).toString("hex"), 10);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `deleted+${randomUUID()}@account.invalid`,
        passwordHash: replacementPasswordHash,
        isVerified: false,
        isSuspended: true,
        isDeleted: true,
        deletedAt: new Date(),
      },
    });
    await tx.profile.updateMany({
      where: { userId },
      data: {
        fullName: "Deleted member",
        bio: null,
        department: null,
        professionalBackground: null,
        trainingHistory: null,
        careerGoals: null,
        mentorshipNeeds: null,
        mentorshipRole: null,
        availability: null,
        isPublic: false,
        avatarUrl: null,
        coverImageUrl: null,
        coverPositionX: 50,
        coverPositionY: 50,
      },
    });
    await tx.profileSkill.deleteMany({ where: { profile: { is: { userId } } } });
    await tx.profileInterest.deleteMany({ where: { profile: { is: { userId } } } });
    await tx.profileMentorshipTopic.deleteMany({ where: { profile: { is: { userId } } } });
    await tx.flightReconnect.deleteMany({ where: { userId } });
    await tx.message.updateMany({
      where: { senderId: userId },
      data: { body: "[message removed by account owner]" },
    });
    await tx.feedback.updateMany({ where: { userId }, data: { comment: null } });
    await tx.report.updateMany({ where: { reporterId: userId }, data: { description: null } });
    await tx.opportunity.deleteMany({ where: { postedById: userId } });
    await tx.event.deleteMany({ where: { createdById: userId } });
    await tx.verificationToken.deleteMany({ where: { userId } });
    await tx.authSession.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
  });

  if (process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL === "1" && process.env.BLOB_STORE_ID)) {
    for (const imageUrl of [profileImages?.avatarUrl, profileImages?.coverImageUrl].filter(Boolean)) {
      try {
        const url = new URL(imageUrl);
        if (url.protocol === "https:" && (url.hostname === "blob.vercel-storage.com" || url.hostname.endsWith(".blob.vercel-storage.com"))) {
          await del(imageUrl);
        }
      } catch {
        // Account anonymization and image removal should not fail due to Blob cleanup.
      }
    }
  }

  await logActivity({
    actorId: userId,
    targetId: userId,
    actionType: "ACCOUNT_ANONYMIZED",
    summary: "Deleted their account and anonymized personal profile data",
  });

  return NextResponse.json({ message: "Account deleted and personal profile data anonymized." });
}
