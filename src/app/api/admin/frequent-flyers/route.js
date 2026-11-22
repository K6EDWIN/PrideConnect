import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  try {
    const records = await prisma.frequentFlyerVerification.findMany({
      where: { status: "PENDING", user: { role: "FREQUENT_FLYER", isDeleted: false } },
      select: { id: true, createdAt: true, user: { select: { id: true, email: true, createdAt: true, profile: { select: { fullName: true, department: true, mentorshipRole: true } } } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    const reviews = records.map((record) => ({
      id: record.id,
      submittedAt: record.createdAt,
      member: record.user,
    }));
    return NextResponse.json({ reviews });
  } catch (error) {
    console.error("Could not load Asante member verification reviews:", error);
    const migrationMissing = ["P2021", "P2022"].includes(error?.code)
      || /FrequentFlyerVerification|reviewNote/i.test(error?.meta?.table || error?.message || "");
    return NextResponse.json({
      error: migrationMissing
        ? "Asante member review is unavailable until its database migration is applied."
        : "Could not load Asante member review records.",
    }, { status: 500 });
  }
}
