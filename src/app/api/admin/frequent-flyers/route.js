import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  try {
    const params = new URL(request.url).searchParams;
    const query = params.get("q")?.trim().slice(0, 120) || "";
    const requestedPage = Number.parseInt(params.get("page") || "1", 10);
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const pageSize = 25;
    const where = {
      status: "PENDING",
      user: {
        role: "FREQUENT_FLYER",
        isDeleted: false,
        ...(query ? {
          OR: [
            { email: { contains: query, mode: "insensitive" } },
            { profile: { is: { fullName: { contains: query, mode: "insensitive" } } } },
            { profile: { is: { department: { contains: query, mode: "insensitive" } } } },
          ],
        } : {}),
      },
    };
    const [records, total] = await Promise.all([
      prisma.frequentFlyerVerification.findMany({
        where,
        select: { id: true, createdAt: true, user: { select: { id: true, email: true, createdAt: true, profile: { select: { fullName: true, department: true, mentorshipRole: true } } } } },
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.frequentFlyerVerification.count({ where }),
    ]);

    const reviews = records.map((record) => ({
      id: record.id,
      submittedAt: record.createdAt,
      member: record.user,
    }));
    return NextResponse.json({ reviews, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
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
