import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/directory?role=&skill=&interest=&q=
// Lists public, verified stakeholder profiles for browsing/search -- the
// member directory. Excludes the logged-in user's own profile.
export async function GET(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const role = searchParams.get("role") || "";
  const skillId = searchParams.get("skill") || "";
  const interestId = searchParams.get("interest") || "";
  const department = searchParams.get("department")?.trim() || "";
  const q = searchParams.get("q")?.trim().slice(0, 120) || "";
  const requestedPage = Number.parseInt(searchParams.get("page") || "1", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(requestedPage, 100000)) : 1;
  const pageSize = 24;
  const validRoles = ["STAFF", "ALUMNI", "FORMER_STAFF", "FREQUENT_FLYER"];
  const publicMemberWhere = {
    isPublic: true,
    user: { isVerified: true, isSuspended: false, isDeleted: false, isDemo: false },
  };

  if (searchParams.get("departments") === "true") {
    const departments = await prisma.profile.findMany({
      where: { ...publicMemberWhere, department: { not: null } },
      select: { department: true },
      distinct: ["department"],
      orderBy: { department: "asc" },
    });
    return NextResponse.json({ departments: departments.map((item) => item.department).filter(Boolean) }, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  }

  const where = {
      isPublic: true,
      userId: { not: session.user.id },
      user: {
        isVerified: true,
        isSuspended: false,
        isDeleted: false,
        isDemo: false,
        ...(validRoles.includes(role) ? { role } : {}),
      },
      ...(skillId ? { skills: { some: { skillId } } } : {}),
      ...(interestId ? { interests: { some: { interestId } } } : {}),
      ...(department ? { department: { equals: department, mode: "insensitive" } } : {}),
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { department: { contains: q, mode: "insensitive" } },
              { bio: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
  const [profiles, total] = await Promise.all([
    prisma.profile.findMany({
      where,
      select: {
        userId: true,
        fullName: true,
        avatarUrl: true,
        department: true,
        bio: true,
        mentorshipRole: true,
        availability: true,
        user: { select: { id: true, role: true } },
        skills: { select: { skill: { select: { name: true } } } },
        interests: { select: { interest: { select: { name: true } } } },
      },
      orderBy: [{ fullName: "asc" }, { userId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.profile.count({ where }),
  ]);

  const results = profiles.map((p) => ({
    userId: p.user.id,
    role: p.user.role,
    fullName: p.fullName,
    avatarUrl: p.avatarUrl,
    department: p.department,
    bio: p.bio,
    mentorshipRole: p.mentorshipRole,
    availability: p.availability,
    skills: p.skills.map((s) => s.skill.name),
    interests: p.interests.map((i) => i.interest.name),
  }));

  return NextResponse.json({ profiles: results, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}
