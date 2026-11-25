import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { adminApiErrorResponse } from "@/lib/admin-api-error";

// GET /api/admin/users
// Lists every user with their verification/suspension status. Admin-only.
export async function GET(request) {
  try {
    return await getAdminUsers(request);
  } catch (error) {
    return adminApiErrorResponse("Admin users", error);
  }
}

async function getAdminUsers(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim().slice(0, 120) || "";
  const role = params.get("role") || "ALL";
  const status = params.get("status") || "ALL";
  const requestedPage = Number.parseInt(params.get("page") || "1", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const pageSize = 50;
  const validRoles = ["ALUMNI", "STAFF", "FORMER_STAFF", "FREQUENT_FLYER", "ADMIN"];
  const filters = [{ isDemo: false }, { isDeleted: false }];
  if (validRoles.includes(role)) filters.push({ role });
  if (status === "VERIFIED") filters.push({ isVerified: true, isSuspended: false });
  if (status === "UNVERIFIED") filters.push({ isVerified: false, isSuspended: false });
  if (status === "SUSPENDED") filters.push({ isSuspended: true });
  if (query) {
    filters.push({
      OR: [
        { email: { contains: query, mode: "insensitive" } },
        { profile: { is: { fullName: { contains: query, mode: "insensitive" } } } },
        { profile: { is: { department: { contains: query, mode: "insensitive" } } } },
      ],
    });
  }
  const where = { AND: filters };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        isVerified: true,
        isSuspended: true,
        createdAt: true,
        profile: { select: { fullName: true, department: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return NextResponse.json({ users, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}
