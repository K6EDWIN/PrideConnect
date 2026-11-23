import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readRequestJson } from "@/lib/request-json";

const ACTIONS = {
  VERIFY: { field: "isVerified", value: true },
  UNVERIFY: { field: "isVerified", value: false },
  SUSPEND: { field: "isSuspended", value: true },
  UNSUSPEND: { field: "isSuspended", value: false },
};

// PATCH /api/admin/users/[id]
// Verifies/unverifies or suspends/unsuspends a user, logging the action to
// AdminAction for audit purposes. Admin-only.
export async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;
  const parsed = await readRequestJson(request);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  }
  const { action } = parsed.data;

  const actionDef = ACTIONS[action];
  if (!actionDef) {
    return NextResponse.json(
      { error: "action must be one of VERIFY, UNVERIFY, SUSPEND, UNSUSPEND" },
      { status: 400 }
    );
  }

  const targetUser = await prisma.user.findUnique({ where: { id } });
  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const [user] = await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: { [actionDef.field]: actionDef.value },
    }),
    prisma.adminAction.create({
      data: {
        adminId: session.user.id,
        actionType: action,
        targetId: id,
        notes: JSON.stringify({
          version: 1,
          actorRole: "ADMIN",
          actorType: "ADMIN",
          summary: `${action.replaceAll("_", " ").toLowerCase()} account ${targetUser.profile?.fullName || targetUser.email}`,
          details: { targetEmail: targetUser.email, targetName: targetUser.profile?.fullName || null, changedField: actionDef.field, newValue: actionDef.value },
        }),
      },
    }),
  ]);

  return NextResponse.json({ user });
}
