"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button, Tag } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import ReportButton from "@/components/ReportButton";
import { readApiResponse } from "@/lib/read-api-response";

const TYPE_OPTIONS = [
  "Career Opening",
  "Internship",
  "Industry Workshop",
  "Alumni Reunion",
];

export default function OpportunitiesPage() {
  const { status, data: session } = useSession();
  const router = useRouter();

  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    title: "",
    description: "",
    type: TYPE_OPTIONS[0],
    sourceUrl: "",
    expiresAt: "",
    division: "",
    employmentType: "",
  });
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState("");
  const [postNotice, setPostNotice] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [careersRefreshedAt, setCareersRefreshedAt] = useState("");
  const [careersRefreshing, setCareersRefreshing] = useState(false);
  const careersRefreshRef = useRef(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    let saved = [];
    const loadSaved = async () => {
      try {
        const response = await fetch("/api/opportunities");
        const data = await readApiResponse(response, "Could not load saved opportunities");
        saved = data.opportunities || [];
        if (!cancelled) setOpportunities((current) => {
          const merged = new Map(current.map((item) => [item.sourceUrl || item.id, item]));
          saved.forEach((item) => { if (!merged.has(item.sourceUrl || item.id)) merged.set(item.sourceUrl || item.id, item); });
          return [...merged.values()];
        });
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || "Saved opportunities are temporarily unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const refreshCareers = async () => {
      if (!cancelled) setCareersRefreshing(true);
      try {
        const response = await fetch("/api/opportunities/live", { cache: "no-store" });
        const data = await readApiResponse(response, "Could not refresh Kenya Airways Careers listings");
        if (!cancelled) {
          const merged = new Map(saved.map((item) => [item.sourceUrl || item.id, item]));
          (data.opportunities || []).forEach((item) => merged.set(item.sourceUrl, item));
          setOpportunities([...merged.values()].sort((a, b) => new Date(b.createdAt || b.expiresAt || 0) - new Date(a.createdAt || a.expiresAt || 0)));
          setCareersRefreshedAt(data.refreshedAt ? new Date(data.refreshedAt).toLocaleTimeString("en-KE", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit" }) : "");
          setError("");
        }
      } catch (refreshError) {
        if (!cancelled && saved.length === 0) setError(refreshError.message || "Could not load opportunities.");
      } finally {
        if (!cancelled) setCareersRefreshing(false);
      }
    };
    careersRefreshRef.current = refreshCareers;
    loadSaved();
    refreshCareers();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshCareers();
    }, 60000);
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") refreshCareers();
    };
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => { cancelled = true; careersRefreshRef.current = null; window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshOnReturn); };
  }, [status]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const importCareerListing = async () => {
    setImporting(true);
    setImportError("");
    try {
      const response = await fetch("/api/opportunities/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl }),
      });
      const data = await readApiResponse(response, "Could not import careers listing");
      setForm((current) => ({ ...current, ...data.opportunity }));
      setPostNotice("Listing details imported. Review them and publish when ready.");
    } catch (err) {
      setImportError(err.message || "Could not read that Kenya Airways Careers listing.");
    } finally {
      setImporting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setPosting(true);
    setPostError("");
    setPostNotice("");

    try {
      const res = await fetch("/api/opportunities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await readApiResponse(res, "Could not post opportunity");

      setPosting(false);

      setOpportunities((prev) => [
        { ...data.opportunity, postedBy: { profile: { fullName: "You" } } },
        ...prev,
      ]);
      setForm({ title: "", description: "", type: TYPE_OPTIONS[0], sourceUrl: "", expiresAt: "", division: "", employmentType: "" });
      setImportUrl("");
      setPostNotice("Your opportunity has been published.");
    } catch (err) {
      setPosting(false);
      setPostError(err.message);
    }
  };

  const filteredOpportunities = opportunities.filter((opportunity) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [opportunity.title, opportunity.description, opportunity.type, opportunity.division, opportunity.employmentType, opportunity.postedBy?.profile?.fullName]
      .some((value) => String(value || "").toLowerCase().includes(query));
    const matchesType = !typeFilter || opportunity.type === typeFilter;
    const matchesSource = !sourceFilter || (sourceFilter === "official" ? Boolean(opportunity.sourceUrl) : !opportunity.sourceUrl);
    return matchesSearch && matchesType && matchesSource;
  });
  const visibleOpportunities = showAll ? filteredOpportunities : filteredOpportunities.slice(0, 6);

  if (status === "loading" || loading) {
    return (
      <KQAppShell>
        <div className="app-page">
          <div className="p-12 text-center text-gray-500 font-medium">
            <Icon name="opportunity" size={28} className="mx-auto mb-3 text-[#bb162b] animate-spin" />
            Loading opportunities board...
          </div>
        </div>
      </KQAppShell>
    );
  }

  return (
    <KQAppShell>
      <div className="app-page">
        {/* Title */}
        <div className="page-title flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="eyebrow">CAREER &amp; GROWTH</div>
            <h1>Opportunities Hub</h1>
            <p>
              Current Kenya Airways careers listings refresh automatically, alongside community opportunities.
            </p>
            {careersRefreshedAt && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>Careers feed checked {careersRefreshedAt}. It refreshes once a minute while this page is open.</span><button type="button" onClick={() => careersRefreshRef.current?.()} disabled={careersRefreshing} className="font-semibold text-[#c8102e] hover:underline disabled:opacity-60">{careersRefreshing ? "Refreshing…" : "Refresh now"}</button></div>}
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <a href="#opportunity-list" className="rounded-lg bg-[#c8102e] px-4 py-2 text-center text-sm font-semibold text-white hover:bg-[#a90d27]">Explore opportunities</a>
            <a href="#opportunity-post" className="rounded-lg border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50">Post an opportunity</a>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-12">
          {/* Post an opportunity card */}
          <section id="opportunity-post" className="order-2 scroll-mt-24">
            <div className="mb-4">
              <div className="eyebrow">CONTRIBUTE TO THE COMMUNITY</div>
              <h2 className="text-2xl font-bold text-slate-900">Opportunities Post</h2>
              <p className="mt-1 text-sm text-slate-600">Create and publish an opening for verified stakeholders.</p>
            </div>
            <form
              onSubmit={handleSubmit}
              className="card max-w-4xl p-6 space-y-4"
            >
              {session?.user?.role === "ADMIN" && <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
                <label htmlFor="kq-careers-url" className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-700">Import an official KQ Careers listing</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input id="kq-careers-url" type="url" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="Paste a Kenya Airways job details link" className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800" />
                  <Button type="button" variant="secondary" disabled={importing || !importUrl.trim()} onClick={importCareerListing}>{importing ? "Reading…" : "Import details"}</Button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-600">We’ll fill a draft from the official listing. Check the details and deadline before publishing.</p>
                {importError && <p role="alert" className="mt-2 text-xs text-red-700">{importError}</p>}
                {form.sourceUrl && <p className="mt-2 break-all text-xs text-sky-800">Source: {form.sourceUrl}</p>}
              </div>}

              <div className="flex items-center gap-3 pb-3 border-b border-slate-100">
                <span className="p-2 bg-[#c8102e]/10 text-[#c8102e] rounded-lg">
                  <Icon name="opportunity" size={16} />
                </span>
                <div>
                  <h2 className="font-bold text-slate-900 text-sm">Post an Opportunity</h2>
                  <p className="text-slate-500 text-xs">Share an opening with verified stakeholders</p>
                </div>
              </div>

              <div className="space-y-4">
                {form.sourceUrl && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div><label htmlFor="opportunity-division" className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-700">Division</label><input id="opportunity-division" name="division" value={form.division || ""} onChange={handleChange} maxLength={120} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800" /></div>
                    <div><label htmlFor="opportunity-employment" className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-700">Employment type</label><input id="opportunity-employment" name="employmentType" value={form.employmentType || ""} onChange={handleChange} maxLength={120} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800" /></div>
                  </div>
                )}
                <div>
                  <label htmlFor="opportunity-title" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Title
                  </label>
                  <input
                    name="title"
                    id="opportunity-title"
                    placeholder="e.g. Graduate Trainee Flight Dispatcher"
                    value={form.title}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="opportunity-description" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Description
                  </label>
                  <textarea
                    name="description"
                    id="opportunity-description"
                    placeholder="Details about requirements, station location, and how to apply..."
                    value={form.description}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                    rows={4}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="opportunity-type" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Opportunity Type
                  </label>
                  <select
                    name="type"
                    id="opportunity-type"
                    value={form.type}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition text-slate-800"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                {session?.user?.role === "ADMIN" && <div>
                  <label htmlFor="opportunity-source" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">Official source / application link <span className="font-normal normal-case text-slate-500">(optional)</span></label>
                  <input id="opportunity-source" name="sourceUrl" type="url" value={form.sourceUrl || ""} onChange={handleChange} placeholder="https://careers.kenya-airways.com/…" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800" />
                </div>}
                {form.sourceUrl && <div><label htmlFor="opportunity-deadline" className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-700">Application deadline</label><input id="opportunity-deadline" type="date" required value={form.expiresAt ? String(form.expiresAt).slice(0, 10) : ""} onChange={(event) => setForm((current) => ({ ...current, expiresAt: event.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800" /></div>}

                {postError && (
                  <p role="alert" className="text-red-700 text-xs bg-red-50 border border-red-200 p-2.5 rounded-lg">
                    {postError}
                  </p>
                )}
                {postNotice && <p role="status" className="text-emerald-800 text-xs bg-emerald-50 border border-emerald-200 p-2.5 rounded-lg">{postNotice}</p>}

                <Button
                  type="submit"
                  disabled={posting}
                  className="w-full"
                  icon="arrow"
                >
                  {posting ? "Publishing..." : "Publish Opportunity"}
                </Button>
              </div>
            </form>
          </section>

          {/* List of Opportunities */}
          <section id="opportunity-list" className="order-1 space-y-5 scroll-mt-24">
            <div className="flex flex-col gap-1 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="eyebrow">DISCOVER CAREER &amp; COMMUNITY LISTINGS</div>
                <h2 className="text-2xl font-bold text-slate-900">Opportunities Available</h2>
                <p className="mt-1 text-sm text-slate-600">Browse current Kenya Airways openings and opportunities shared by members.</p>
              </div>
              <span className="text-sm font-semibold text-slate-600">{filteredOpportunities.length} {filteredOpportunities.length === 1 ? "listing" : "listings"}</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Active Listings ({filteredOpportunities.length})
              </span>
              {opportunities.length > 6 && <button type="button" onClick={() => setShowAll((value) => !value)} className="text-sm font-semibold text-[#c8102e] hover:underline">{showAll ? "Show fewer" : `View all ${filteredOpportunities.length}`}</button>}
            </div>

            <div className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              <input aria-label="Search opportunities" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, skills, division…" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 sm:col-span-2" />
              <select aria-label="Filter by opportunity type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"><option value="">All opportunity types</option>{[...new Set(opportunities.map((item) => item.type))].sort().map((type) => <option key={type} value={type}>{type}</option>)}</select>
              <select aria-label="Filter by listing source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"><option value="">All sources</option><option value="official">Kenya Airways Careers</option><option value="community">Community posts</option></select>
            </div>

            {error ? (
              <p className="text-red-600 text-sm">{error}</p>
            ) : opportunities.length === 0 ? (
              <div className="p-12 text-center card text-slate-500">
                No current opportunities are listed yet.
              </div>
            ) : filteredOpportunities.length === 0 ? (
              <div className="card p-8 text-center text-sm text-slate-600">No opportunities match these filters. Clear a filter or try another search.</div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {visibleOpportunities.map((o) => (
                  <article
                    key={o.id}
                    className="card p-5 hover:border-slate-300 transition"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="font-bold text-base text-slate-900">{o.title}</h3>
                        <span className="text-xs text-slate-500 break-words">
                          Shared by {o.postedBy?.profile?.fullName || "Kenya Airways Member"}
                        </span>
                      </div>
                      <Tag gold={o.type.includes("Career")} className="shrink-0">{o.type}</Tag>
                    </div>

                    <p className="text-sm text-slate-700 leading-relaxed mt-2 whitespace-pre-wrap">
                      {o.description}
                    </p>

                    {(o.division || o.employmentType || o.expiresAt) && <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">{o.division && <span className="rounded-full bg-slate-100 px-2.5 py-1">{o.division}</span>}{o.employmentType && <span className="rounded-full bg-slate-100 px-2.5 py-1">{o.employmentType}</span>}{o.expiresAt && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-900">Closes {new Date(o.expiresAt).toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi" })}</span>}</div>}

                    <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                        <Icon name="check" size={13} /> {o.sourceUrl ? "Source: Kenya Airways Careers" : "Community post"}{o.liveSource ? " · Live feed" : ""}
                      </span>
                      {o.sourceUrl && <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50">View original &amp; apply</a>}
                    </div>
                    <ReportButton targetType="OPPORTUNITY" targetId={o.id} />
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </KQAppShell>
  );
}
