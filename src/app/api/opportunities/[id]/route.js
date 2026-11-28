import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const opportunity = await prisma.opportunity.findFirst({
    where: {
      id,
      isHidden: false,
      postedBy: { isDeleted: false },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { postedBy: { select: { id: true, profile: { select: { fullName: true } } } } },
  });
  if (!opportunity) return NextResponse.json({ error: "This opportunity is no longer available." }, { status: 404 });

  return NextResponse.json({ opportunity: { ...opportunity, source: "community" } });
}
