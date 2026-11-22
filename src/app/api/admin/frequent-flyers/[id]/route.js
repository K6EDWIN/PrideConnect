import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit-log";
import { escapeHtml } from "@/lib/app-url";
import { GMAIL_SENDER, sendAppEmail } from "@/lib/gmail";
import { decryptFrequentFlyerEvidence } from "@/lib/frequent-flyer-verification";

const REVIEW_STATUSES = new Set(["RECORDS_MATCHED", "NOT_CONFIRMED"]);

export async function GET(_request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  try {
    const { id } = await params;
    const record = await prisma.frequentFlyerVerification.findUnique({
      where: { id }, select: { evidenceCiphertext: true, status: true, userId: true },
    });
    if (!record || record.status !== "PENDING" || !record.evidenceCiphertext) {
      return NextResponse.json({ error: "Pending review evidence is unavailable." }, { status: 404 });
    }
    await logActivity({
      actorId: session.user.id, targetId: record.userId,
      actionType: "FREQUENT_FLYER_EVIDENCE_ACCESSED",
      summary: "Opened private Asante Rewards review evidence",
      details: { verificationId: id },
    });
    return NextResponse.json({ evidence: decryptFrequentFlyerEvidence(record.evidenceCiphertext) });
  } catch (error) {
    console.error("Could not open private Asante member review evidence:", error);
    return NextResponse.json({ error: "Could not open the private review evidence." }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!REVIEW_STATUSES.has(body.status)) {
    return NextResponse.json({ error: "Choose a valid review outcome." }, { status: 400 });
  }
  if (body.reviewNote != null && (typeof body.reviewNote !== "string" || body.reviewNote.trim().length > 1000)) {
    return NextResponse.json({ error: "Review notes must be 1000 characters or fewer." }, { status: 400 });
  }
  const reviewNote = typeof body.reviewNote === "string" ? body.reviewNote.trim() : "";
  if (body.status === "NOT_CONFIRMED" && !reviewNote) {
    return NextResponse.json({ error: "Add a reason before marking these details as not confirmed." }, { status: 400 });
  }

  const record = await prisma.frequentFlyerVerification.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, isDeleted: true, profile: { select: { fullName: true } } } } },
  });
  if (!record || record.user.isDeleted) return NextResponse.json({ error: "Review record not found." }, { status: 404 });
  if (record.status !== "PENDING") return NextResponse.json({ error: "This membership review has already been completed." }, { status: 409 });

  const reviewedAt = new Date();
  const result = await prisma.frequentFlyerVerification.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: body.status,
      reviewerId: session.user.id,
      reviewedAt,
      reviewNote: reviewNote || null,
      evidenceCiphertext: null,
    },
  });
  if (result.count !== 1) return NextResponse.json({ error: "This membership review has already been completed." }, { status: 409 });

  await logActivity({
    actorId: session.user.id,
    targetId: record.user.id,
    actionType: "FREQUENT_FLYER_REVIEWED",
    summary: `Reviewed an Asante Rewards membership request: ${body.status}`,
    details: { verificationId: id, status: body.status },
  });

  let notificationSent = false;
  try {
    const name = escapeHtml(record.user.profile?.fullName || "member");
    const outcome = body.status === "RECORDS_MATCHED"
      ? "Your Asante Rewards details were matched against the records available to our authorized reviewer."
      : "We could not confirm your Asante Rewards details against the records available to our authorized reviewer.";
    const note = reviewNote
      ? `<p><strong>Reviewer note:</strong> ${escapeHtml(reviewNote)}</p>`
      : "";
    await sendAppEmail({
      to: record.user.email,
      subject: "Update on your Kenya Airways PrideConnect membership review",
      html: `<div style="font-family:Arial,sans-serif;color:#14243a;max-width:600px;margin:auto"><h2>Hello ${name},</h2><p>${outcome}</p>${note}<p>This review only covers the membership details you submitted. Contact the PrideConnect administrator if you believe this result is incorrect.</p></div>`,
      text: `Hello ${record.user.profile?.fullName || "member"},\n\n${outcome}${reviewNote ? `\n\nReviewer note: ${reviewNote}` : ""}\n\nContact the PrideConnect administrator if you believe this result is incorrect.\n\nKenya Airways PrideConnect (${GMAIL_SENDER})`,
    });
    notificationSent = true;
  } catch (error) {
    console.error("Asante member review was saved, but notification email could not be sent:", error);
  }

  return NextResponse.json({ status: body.status, notificationSent });
}
