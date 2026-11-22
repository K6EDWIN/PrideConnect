"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import { readApiResponse } from "@/lib/read-api-response";

function formatDate(value) {
  return new Date(value).toLocaleDateString("en-KE", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi",
  });
}

export default function FrequentFlyerReviewsPage() {
  const { status, data: session } = useSession();
  const router = useRouter();
  const [reviews, setReviews] = useState([]);
  const [notes, setNotes] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState("");
  const [notice, setNotice] = useState("");
  const [evidenceById, setEvidenceById] = useState({});
  const [openingId, setOpeningId] = useState("");

  const loadReviews = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/admin/frequent-flyers", { cache: "no-store" });
      const data = await readApiResponse(response, "Could not load Asante member reviews");
      setReviews(data.reviews || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load Asante member reviews.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
    if (status === "authenticated" && session?.user?.role !== "ADMIN") router.replace("/recommendations");
    if (status === "authenticated" && session?.user?.role === "ADMIN") {
      Promise.resolve().then(loadReviews);
    }
  }, [status, session?.user?.role, router, loadReviews]);

  async function reviewRecord(review, reviewStatus) {
    const reviewNote = notes[review.id]?.trim() || "";
    if (reviewStatus === "NOT_CONFIRMED" && !reviewNote) {
      setError("Add a short reason before marking a member’s details as not confirmed.");
      return;
    }
    setSavingId(review.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/frequent-flyers/${encodeURIComponent(review.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: reviewStatus, reviewNote }),
      });
      const data = await readApiResponse(response, "Could not save the membership review");
      setReviews((current) => current.filter((item) => item.id !== review.id));
      setEvidenceById((current) => { const next = { ...current }; delete next[review.id]; return next; });
      setNotice(data.notificationSent
        ? "Review saved and the member was emailed."
        : "Review saved. The member email could not be sent; check email service settings.");
    } catch (reviewError) {
      setError(reviewError.message || "Could not save the membership review.");
    } finally {
      setSavingId("");
    }
  }

  async function openEvidence(review) {
    if (evidenceById[review.id]) return;
    setOpeningId(review.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/frequent-flyers/${encodeURIComponent(review.id)}`, { cache: "no-store" });
      const data = await readApiResponse(response, "Could not open private review evidence");
      setEvidenceById((current) => ({ ...current, [review.id]: data.evidence }));
    } catch (openError) {
      setError(openError.message || "Could not open private review evidence.");
    } finally {
      setOpeningId("");
    }
  }

  return (
    <KQAppShell>
      <div className="app-page space-y-6">
        <section className="page-title">
          <div>
            <div className="eyebrow">PRIVATE ADMIN REVIEW</div>
            <h1>Asante Member Reviews</h1>
            <p>Compare submitted membership and recent-flight details with authorized records before recording an outcome.</p>
          </div>
        </section>

        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-950">
          <strong>Manual records check required.</strong> PrideConnect is not connected to Kenya Airways or Asante Rewards verification systems. Reviewers must check details using records they are authorized to access. Do not mark an account confirmed based only on the information submitted here.
        </div>

        {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><span>{error}</span><Button variant="secondary" onClick={loadReviews}>Retry</Button></div>}
        {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}

        {loading ? (
          <div className="card p-10 text-center text-slate-500"><Icon name="flight" size={24} className="mx-auto mb-2 animate-pulse text-[#c8102e]" />Loading private review requests…</div>
        ) : reviews.length === 0 ? (
          <div className="card p-10 text-center">
            <h2 className="font-bold text-slate-900">No pending reviews</h2>
            <p className="mt-1 text-sm text-slate-600">New Asante member review requests will appear here after registration.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm font-semibold text-slate-700">{reviews.length} pending {reviews.length === 1 ? "review" : "reviews"}</p>
            {reviews.map((review) => {
              const evidence = evidenceById[review.id];
              const pending = savingId === review.id;
              return (
                <article key={review.id} className="card space-y-4 p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">{review.member.profile?.fullName || "Name not provided"}</h2>
                      <p className="text-sm text-slate-600">{review.member.email}</p>
                      <p className="mt-1 text-xs text-slate-500">Registered {formatDate(review.member.createdAt)} · Submitted {formatDate(review.submittedAt)}</p>
                    </div>
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">Pending review</span>
                  </div>

                  {evidence ? (
                    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                      <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Asante Rewards number</dt><dd className="mt-1 break-all font-mono font-semibold text-slate-900">{evidence.asanteRewardsNumber}</dd></div>
                      <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last flight</dt><dd className="mt-1 font-semibold text-slate-900">{evidence.lastFlightAirline} · {evidence.lastFlightNumber}</dd></div>
                      <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Route</dt><dd className="mt-1 font-semibold text-slate-900">{evidence.origin} → {evidence.destination}</dd></div>
                      <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approximate travel date</dt><dd className="mt-1 font-semibold text-slate-900">{formatDate(evidence.lastFlightDate)}</dd></div>
                    </dl>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="mb-3 text-sm text-slate-600">Private flight and membership evidence is encrypted and opened only when needed for a review.</p>
                      <Button variant="secondary" disabled={Boolean(openingId)} onClick={() => openEvidence(review)}>{openingId === review.id ? "Opening evidence…" : "Open private evidence"}</Button>
                    </div>
                  )}

                  <div>
                    <label htmlFor={`review-note-${review.id}`} className="mb-1 block text-xs font-semibold text-slate-700">Private review note {" "}<span className="font-normal text-slate-500">(required if details cannot be confirmed)</span></label>
                    <textarea id={`review-note-${review.id}`} value={notes[review.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [review.id]: event.target.value }))} maxLength={1000} rows={2} className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 outline-none focus:border-[#c8102e]" placeholder="Record the outcome and any follow-up needed; avoid unnecessary personal data." />
                  </div>

                  <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
                    <Button variant="secondary" disabled={pending || !notes[review.id]?.trim()} onClick={() => reviewRecord(review, "NOT_CONFIRMED")}>{pending ? "Saving…" : "Could not confirm"}</Button>
                    <Button disabled={pending} onClick={() => reviewRecord(review, "RECORDS_MATCHED")}>{pending ? "Saving…" : "Confirmed against records"}</Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </KQAppShell>
  );
}
