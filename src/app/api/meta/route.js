import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Returns the full skill/interest lists used to populate the profile form's
// multi-select checkboxes. Doesn't need auth -- it's just reference data.
export async function GET() {
  const [skills, interests] = await Promise.all([
    prisma.skill.findMany({ orderBy: { name: "asc" } }),
    prisma.interest.findMany({ orderBy: { name: "asc" } }),
  ]);

  return NextResponse.json({ skills, interests }, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
