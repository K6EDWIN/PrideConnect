"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Icon } from "@/components/KQIcons";
import ReportButton from "@/components/ReportButton";
import { readApiResponse } from "@/lib/read-api-response";

function DetailSection({ title, children }) {
  if (!children) return null;
  return <section className="mt-7"><h2 className="text-lg font-bold text-slate-900">{title}</h2><p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-7 text-slate-700">{children}</p></section>;
}

export default function OpportunityDetail({ opportunityId, returnTo }) {
  const { status } = useSession();
  const router = useRouter();
  const [opportunity, setOpportunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    const isLive = opportunityId.startsWith("kq-");
    const endpoint = isLive
      ? `/api/opportunities/live?id=${encodeURIComponent(opportunityId)}`
      : `/api/opportunities/${encodeURIComponent(opportunityId)}`;
    (async () => {
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        const data = await readApiResponse(response, "Could not load this opportunity");
        setOpportunity(data.opportunity);
      } catch (fetchError) {
        if (fetchError.name !== "AbortError") setError(fetchError.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [status, opportunityId]);

  if (status === "loading" || loading) return <KQAppShell><main className="app-page"><div className="card p-10 text-center text-slate-600">Loading opportunity details…</div></main></KQAppShell>;
  if (error || !opportunity) return <KQAppShell><main className="app-page"><div className="card p-8"><p role="alert" className="text-red-700">{error || "This opportunity could not be found."}</p><Link href={returnTo} className="mt-5 inline-flex items-center gap-2 font-semibold text-[#c8102e]"><span aria-hidden="true">←</span> Back to Opportunities</Link></div></main></KQAppShell>;

  const isKQ = Boolean(opportunity.sourceUrl);
  const poster = opportunity.postedBy?.profile?.fullName || (isKQ ? "Kenya Airways Careers" : "Kenya Airways community member");
  const banner = opportunity.imageUrl || (isKQ ? "/opportunity-kq-careers.svg" : "/community-post.svg");
  const deadline = opportunity.expiresAt ? new Date(opportunity.expiresAt) : null;

  return <KQAppShell>
    <main className="app-page mx-auto max-w-5xl">
      <Link href={returnTo} className="mb-5 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50"><span aria-hidden="true">←</span> Back to Opportunities</Link>
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="relative aspect-[1200/420] max-h-[420px] min-h-48 overflow-hidden bg-slate-900">
          <Image src={banner} alt={isKQ ? "Kenya Airways Careers" : "PrideConnect community opportunity"} fill unoptimized sizes="(max-width: 768px) 100vw, 960px" className="object-cover" priority />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-slate-950/10" />
          <span className="absolute bottom-5 left-5 rounded-full border border-white/30 bg-slate-950/55 px-3 py-1.5 text-xs font-bold text-white backdrop-blur">{isKQ ? "Kenya Airways Careers" : "Community opportunity"}</span>
        </div>
        <div className="p-5 sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-[#c8102e]">{opportunity.type || "Opportunity"}</p>
          <h1 className="mt-2 break-words text-3xl font-bold leading-tight text-slate-950 sm:text-4xl">{opportunity.title}</h1>
          <p className="mt-3 text-sm text-slate-600">{isKQ ? "Published by" : "Shared by"} <span className="font-semibold text-slate-800">{poster}</span></p>
          <div className="mt-5 flex flex-wrap gap-2 text-sm">{opportunity.division && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">{opportunity.division}</span>}{opportunity.location && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">{opportunity.location}</span>}{opportunity.employmentType && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">{opportunity.employmentType}</span>}{deadline && <span className="rounded-full bg-amber-50 px-3 py-1.5 text-amber-900">Apply by {deadline.toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi" })}</span>}</div>

          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div>
              <DetailSection title="About this opportunity">{opportunity.description || "No additional description was provided."}</DetailSection>
              <DetailSection title="Responsibilities">{opportunity.responsibilities}</DetailSection>
              <DetailSection title="Qualifications">{opportunity.qualifications}</DetailSection>
              <DetailSection title="Skills and experience">{opportunity.skills}</DetailSection>
              <DetailSection title="Application instructions">{opportunity.howToApply}</DetailSection>
              {!opportunity.liveSource && <div className="mt-8"><ReportButton targetType="OPPORTUNITY" targetId={opportunity.id} /></div>}
            </div>
            <aside className="h-fit rounded-xl border border-slate-200 bg-slate-50 p-5">
              <h2 className="text-base font-bold text-slate-900">{isKQ ? "Application" : "Listing details"}</h2>
              <dl className="mt-4 space-y-4 text-sm">
                <div><dt className="font-semibold text-slate-500">Organisation</dt><dd className="mt-1 text-slate-800">{isKQ ? "Kenya Airways" : "Kenya Airways Community"}</dd></div>
                <div><dt className="font-semibold text-slate-500">Opportunity type</dt><dd className="mt-1 text-slate-800">{opportunity.type || "Not specified"}</dd></div>
                {opportunity.createdAt && <div><dt className="font-semibold text-slate-500">Posted</dt><dd className="mt-1 text-slate-800">{new Date(opportunity.createdAt).toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi" })}</dd></div>}
              </dl>
              {opportunity.sourceUrl
                ? <a href={opportunity.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-[#c8102e] px-4 py-3 text-sm font-bold text-white hover:bg-[#a30d25]">Apply on Kenya Airways Careers <Icon name="arrow" size={16} /></a>
                : <p className="mt-5 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-600">This opportunity was shared by a community member. Contact or application instructions are included above when provided.</p>}
              {opportunity.sourceUrl && deadline && <p className="mt-3 text-xs text-slate-500">Deadline: {deadline.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" })}</p>}
            </aside>
          </div>
        </div>
      </article>
    </main>
  </KQAppShell>;
}
