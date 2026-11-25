"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button, Tag, Avatar } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import { readApiResponse } from "@/lib/read-api-response";

const ROLE_LABELS = {
  ALUMNI: "Pride Centre Alumni",
  STAFF: "Active Flight & Ground Staff",
  FORMER_STAFF: "Former KQ Staff",
  FREQUENT_FLYER: "Frequent Flyer • Asante",
  ADMIN: "System Administrator",
};

const TEMPLATE_MESSAGES = [
  {
    title: "Career Mentorship",
    text: "Hello, I noticed our shared background and skills on Kenya Airways PrideConnect. I would value your guidance and experience as I navigate my career progression in aviation.",
  },
  {
    title: "Fleet & Operational Exchange",
    text: "Greetings. I noticed our mutual focus on flight deck operations and type ratings. I would appreciate the opportunity to connect and exchange technical insights.",
  },
  {
    title: "Pride Centre Alumni Networking",
    text: "Hello! As fellow members of the Kenya Airways Pride Centre ecosystem, I would like to connect for professional collaboration and knowledge sharing.",
  },
];

export default function RecommendationsPage() {
  const { status, data: session } = useSession();
  const router = useRouter();

  const [recommendations, setRecommendations] = useState([]);
  const [meta, setMeta] = useState({
    totalInteractions: 0,
    model: { active: false, trainingExamples: 0, confidence: 0 },
    ranking: { ncfRankingInfluence: 0, relevanceRankingInfluence: 0 },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [minScore, setMinScore] = useState(0);
  const [mentorshipFilter, setMentorshipFilter] = useState("ALL");

  // Modal State
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [requestMessage, setRequestMessage] = useState("");
  const [sendingRequest, setSendingRequest] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState("");
  const [requestError, setRequestError] = useState("");
  const [recommendationFeedback, setRecommendationFeedback] = useState({});
  const loggedViews = useRef(new Set());

  async function recordRecommendationEvent(item, eventType) {
    if (!item?.recommendationId) return;
    if (eventType === "VIEW") {
      if (loggedViews.current.has(item.recommendationId)) return;
      loggedViews.current.add(item.recommendationId);
    }
    try {
      await fetch("/api/recommendation-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommendationId: item.recommendationId, eventType }),
      });
    } catch {
      // Event logging is best-effort and must not interrupt the member flow.
    }
  }

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    } else if (status === "authenticated" && session?.user?.role === "ADMIN") {
      router.push("/admin");
    }
  }, [status, session, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    async function load() {
      try {
        const res = await fetch("/api/recommendations");
        const data = await readApiResponse(res, "Could not load recommendations");

        setRecommendations(data.recommendations || []);
        setRecommendationFeedback(Object.fromEntries(
          (data.recommendations || [])
            .filter((item) => item.recommendationId && item.feedbackRating != null)
            .map((item) => [item.recommendationId, { rating: item.feedbackRating, saving: false, error: "" }])
        ));
        if (data.meta) {
          setMeta(data.meta);
        }
        setLoading(false);
      } catch (err) {
        setError("Network error while loading recommendations: " + err.message);
        setLoading(false);
      }
    }

    load();
  }, [status]);

  const filteredMatches = useMemo(() => {
    return recommendations.filter((item) => {
      const matchesSearch =
        !searchQuery ||
        item.fullName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.department?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.skills &&
          item.skills.some((s) => s.toLowerCase().includes(searchQuery.toLowerCase())));

      const matchesRole = roleFilter === "ALL" || item.role === roleFilter;
      const matchesScore = (item.rankingPercent ?? item.matchPercent) >= minScore;
      const matchesMentorship =
        mentorshipFilter === "ALL" || item.mentorshipRole === mentorshipFilter;

      return matchesSearch && matchesRole && matchesScore && matchesMentorship;
    });
  }, [recommendations, searchQuery, roleFilter, minScore, mentorshipFilter]);

  const profileName = session?.user?.name?.trim();
  const accountLabel = session?.user?.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  const welcomeName = (profileName && !profileName.includes("@") ? profileName : accountLabel)
    ?.split(/\s+/)[0] || "there";
  const welcomeMessage = session?.user?.isFirstSignIn ? "Welcome" : "Welcome back";

  useEffect(() => {
    if (!filteredMatches.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const recommendationId = entry.target.dataset.recommendationId;
        if (!recommendationId || loggedViews.current.has(recommendationId)) continue;
        loggedViews.current.add(recommendationId);
        fetch("/api/recommendation-events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recommendationId, eventType: "VIEW" }),
        }).catch(() => {});
      }
    }, { threshold: 0.5 });
    document.querySelectorAll("[data-recommendation-id]").forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [filteredMatches]);

  async function handleSendRequest(recipientId) {
    if (!requestMessage.trim()) return;
    setSendingRequest(true);
    setFeedbackSuccess("");
    setRequestError("");

    try {
      const res = await fetch("/api/mentorship-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiverId: recipientId,
          type: "MENTORSHIP",
          message: requestMessage,
          recommendationId: selectedMatch?.recommendationId || null,
        }),
      });

      await readApiResponse(res, "Could not send the mentorship request");

      setFeedbackSuccess("Mentorship request dispatched successfully via KQ PrideConnect.");
      await recordRecommendationEvent(selectedMatch, "CONTACT");
      setTimeout(() => {
        setSelectedMatch(null);
        setSendingRequest(false);
        setFeedbackSuccess("");
      }, 1500);
    } catch (error) {
      setRequestError(error.message || "We could not reach the server. Check your connection and try again.");
      setSendingRequest(false);
    }
  }

  async function handleRecommendationFeedback(item, rating) {
    if (!item.recommendationId || recommendationFeedback[item.recommendationId]?.saving) return;
    setRecommendationFeedback((current) => ({
      ...current,
      [item.recommendationId]: { ...current[item.recommendationId], saving: true, error: "" },
    }));
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommendationId: item.recommendationId, rating }),
      });
      await readApiResponse(response, "Feedback could not be saved");
      setRecommendationFeedback((current) => ({
        ...current,
        [item.recommendationId]: { rating, saving: false, error: "" },
      }));
    } catch (error) {
      setRecommendationFeedback((current) => ({
        ...current,
        [item.recommendationId]: { ...current[item.recommendationId], saving: false, error: error.message },
      }));
    }
  }

  if (loading) {
    return (
      <KQAppShell>
        <div className="app-page space-y-6">
          <div className="h-56 rounded-2xl bg-gradient-to-r from-slate-200 to-slate-100 animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 rounded-2xl bg-white border border-slate-200 p-6 space-y-4 animate-pulse">
                <div className="flex gap-4">
                  <div className="w-14 h-14 rounded-xl bg-slate-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-36 bg-slate-200 rounded" />
                    <div className="h-3 w-48 bg-slate-100 rounded" />
                  </div>
                </div>
                <div className="h-20 bg-slate-50 rounded-xl" />
              </div>
            ))}
          </div>
        </div>
      </KQAppShell>
    );
  }

  if (error) {
    return (
      <KQAppShell>
        <div className="p-8 max-w-xl mx-auto my-12 bg-white rounded-2xl border border-red-200 text-center space-y-4 shadow-sm">
          <div className="w-12 h-12 mx-auto rounded-full bg-red-50 text-[#c8102e] flex items-center justify-center">
            <Icon name="close" size={20} />
          </div>
          <h2 className="text-xl font-bold text-slate-900">Network Connection Issue</h2>
          <p className="text-slate-600 text-sm leading-relaxed">{error}</p>
          <Button onClick={() => window.location.reload()}>Retry Connection</Button>
        </div>
      </KQAppShell>
    );
  }

  return (
    <KQAppShell>
      <div className="app-page space-y-6">
        {/* ========================================================= */}
        {/* ATMOSPHERIC COMMAND HEADER (STITCH REDESIGN)               */}
        {/* ========================================================= */}
        <section className="relative rounded-2xl overflow-hidden shadow-xl bg-gradient-to-r from-[#071626] via-[#0b2138] to-[#0e2740] text-white p-6 sm:p-8">
          {/* Ambient Flight Vector Graphics */}
          <div className="absolute inset-0 pointer-events-none opacity-20 overflow-hidden" aria-hidden="true">
            <svg className="w-full h-full" fill="none" preserveAspectRatio="none" viewBox="0 0 1000 320">
              <path d="M-50,280 C200,240 450,90 750,130 C900,150 1050,40 1150,20" stroke="#d5e4fa" strokeDasharray="6 6" strokeWidth="1.5" />
              <path d="M-20,310 C280,290 520,180 820,190 C960,195 1060,110 1120,70" stroke="#c8102e" strokeWidth="2" />
              <circle cx="750" cy="130" fill="#ffffff" r="4" />
              <circle cx="750" cy="130" fill="#c8102e" r="2" />
              <circle cx="450" cy="180" fill="#34d399" r="3.5" />
            </svg>
          </div>

          <div className="relative z-10 flex flex-col gap-6">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="space-y-2 max-w-2xl">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#13283f] text-[#d5e4fa] text-xs font-mono tracking-wider shadow-inner">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>LIVE ADAPTIVE MATCHING ENGINE</span>
                </div>
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight text-white" style={{ color: "#ffffff" }}>
                  {welcomeMessage}, {welcomeName}.
                </h1>
                <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-xl">
                  AI-driven stakeholder matchmaking connecting Kenya Airways alumni, flight operations, and corporate specialists across technical competencies and mentorship goals.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => router.push(session?.user?.role === "ADMIN" ? "/admin/profile" : "/profile")}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition backdrop-blur-xs"
                >
                  <Icon name="profile" size={14} />
                  <span>Improve Profile</span>
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/directory")}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#c8102e] hover:bg-[#a00d24] text-white text-xs font-semibold transition shadow-md"
                >
                  <Icon name="search" size={14} />
                  <span>Browse Directory</span>
                </button>
              </div>
            </div>

            {/* Quick Metrics Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-[#05111e]/60 rounded-xl p-4 backdrop-blur-md border border-white/5">
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Candidate Universe</span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-xl sm:text-2xl font-bold text-white">{recommendations.length}</span>
                  <span className="text-xs text-slate-400">Evaluated</span>
                </div>
              </div>

              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">High Affinity</span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-xl sm:text-2xl font-bold text-emerald-400">
                    {recommendations.filter((r) => (r.rankingPercent ?? r.matchPercent) >= 75).length}
                  </span>
                  <span className="text-xs text-slate-400">Top Matches</span>
                </div>
              </div>

              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Matching Engine</span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-xl sm:text-2xl font-bold text-white">Hybrid ML</span>
                  <span className="text-xs text-emerald-400 font-mono">Active</span>
                </div>
              </div>

              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Learned ranking inputs</span>
                <div className="mt-0.5 flex flex-col">
                  <span className="text-sm font-bold text-amber-300">Member relevance {meta.ranking?.relevanceRankingInfluence ?? 0}%</span>
                  <span className="text-xs text-slate-400">NCF up to {meta.ranking?.ncfRankingInfluence ?? 0}% · acceptance stays separate</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Filter Toolbar */}
        <div className="card p-5 sm:p-6 space-y-4 rounded-2xl border border-slate-200/80 bg-white shadow-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3.5 items-center">
            {/* Search Input */}
            <div className="lg:col-span-5 relative">
              <Icon
                name="search"
                size={16}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                placeholder="Search by stakeholder name, skill, or department..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#c8102e] focus:bg-white transition text-slate-800"
              />
            </div>

            {/* Role Filter */}
            <div className="lg:col-span-3">
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#c8102e] text-slate-700 cursor-pointer"
              >
                <option value="ALL">All Stakeholder Roles</option>
                <option value="STAFF">Active Flight & Ground Staff</option>
                <option value="ALUMNI">Pride Centre Alumni</option>
                <option value="FORMER_STAFF">Former Employees</option>
                <option value="FREQUENT_FLYER">Frequent Flyers</option>
              </select>
            </div>

            {/* Mentorship Filter */}
            <div className="lg:col-span-2">
              <select
                value={mentorshipFilter}
                onChange={(e) => setMentorshipFilter(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-[#c8102e] text-slate-700 cursor-pointer"
              >
                <option value="ALL">All Mentorship</option>
                <option value="MENTOR">Mentors Only</option>
                <option value="MENTEE">Mentees Only</option>
              </select>
            </div>

            {/* Minimum Score Slider */}
            <div className="lg:col-span-2 flex flex-col justify-center">
              <div className="flex justify-between text-xs text-slate-500 font-semibold mb-1">
                <span>Min Match</span>
                <span className="font-mono text-[#c8102e]">{minScore}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="90"
                step="5"
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="w-full accent-[#c8102e] cursor-pointer"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs text-slate-500">
            <span>
              Showing <b className="text-slate-800 font-bold">{filteredMatches.length}</b> matches meeting criteria
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setRoleFilter("ALL");
                setMinScore(0);
                setMentorshipFilter("ALL");
              }}
              className="text-[#c8102e] font-semibold hover:underline cursor-pointer"
            >
              Reset Filters
            </button>
          </div>
        </div>

        {/* Matches Grid */}
        {filteredMatches.length === 0 ? (
          <div className="card p-12 text-center text-slate-500 space-y-3 rounded-2xl border border-slate-200 bg-white">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">
              <Icon name="search" size={22} />
            </div>
            <h3 className="font-bold text-slate-800 text-base">No Stakeholders Match These Filters</h3>
            <p className="text-sm text-slate-500 max-w-sm mx-auto">
              Try adjusting your search query or reset filters to explore more professionals across the network.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {filteredMatches.map((item) => {
              const roleDisplay = ROLE_LABELS[item.role] || item.role;
              const rankingPercent = item.rankingPercent ?? item.matchPercent;

              return (
                <article
                  key={item.userId}
                  data-recommendation-id={item.recommendationId}
                  className="group relative bg-white rounded-2xl border border-slate-200/90 shadow-sm hover:shadow-xl transition-all duration-300 p-6 sm:p-7 flex flex-col justify-between space-y-5"
                >
                  <div className="space-y-4">
                    {/* Header: Role Tag + Match Affinity Tile */}
                    <div className="flex items-start justify-between gap-3 pb-3.5 border-b border-slate-100">
                      <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold flex items-center gap-1.5">
                        <Icon name="flight" size={13} className="text-[#0e2740]" />
                        <span>{roleDisplay}</span>
                      </span>

                      {/* Stitch Score Affinity Tile */}
                      <div className="flex flex-col items-end gap-1 bg-emerald-50/80 border border-emerald-200/70 px-3 py-1.5 rounded-xl shadow-2xs">
                        <div className="flex items-baseline gap-1">
                          <span className="text-base sm:text-lg font-bold text-emerald-800 font-mono">
                            {rankingPercent === 0 ? "New" : `${rankingPercent}%`}
                          </span>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Ranking score</span>
                        </div>
                        <div className="w-20 h-1.5 bg-emerald-200/70 rounded-full overflow-hidden">
                          <div
                            className="bg-emerald-600 h-full rounded-full transition-all duration-500"
                            style={{ width: `${rankingPercent || 15}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Member Profile Info */}
                    <div className="flex items-start gap-4">
                      <div className="relative shrink-0">
                        <Avatar name={item.fullName} size="lg" role={item.role} />
                        <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white flex items-center justify-center text-[10px] text-white">
                          ✓
                        </span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <h2 className="text-base sm:text-lg font-bold text-slate-900 truncate">
                          {item.fullName}
                        </h2>
                        <p className="text-xs text-slate-500 truncate mt-0.5">
                          {item.department || "Department not provided"}
                        </p>
                        <div className="flex items-center gap-2 pt-1 text-slate-500 text-xs">
                          <span className="flex items-center gap-1 font-mono text-[11px]">
                            <span>Kenya Airways Community</span>
                          </span>
                          <span>•</span>
                          <span className="text-xs font-medium text-[#c8102e]">
                            {item.mentorshipRole === "MENTOR"
                              ? "Active Mentor"
                              : item.mentorshipRole === "MENTEE"
                              ? "Seeking Mentorship"
                              : "Mentorship & Networking"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Breakdown Scores */}
                    <div className="p-4 bg-slate-50/90 border border-slate-200/80 rounded-xl space-y-2.5 text-xs">
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="font-medium">Predicted acceptance probability:</span>
                        <b className="font-mono text-slate-900">
                          {item.mlAcceptanceProbability == null ? "Gathering examples" : `${item.mlAcceptanceProbability}%`}
                        </b>
                      </div>
                      <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-[#c8102e] h-full rounded-full transition-all"
                          style={{ width: `${item.mlAcceptanceProbability ?? 0}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-slate-600 pt-1">
                        <span className="font-medium">Profile and member relevance score:</span>
                        <b className="font-mono text-slate-900">{item.profileRelevancePercent ?? item.matchPercent}%</b>
                      </div>
                      <div className="flex items-center justify-between text-slate-600 pt-1">
                        <span className="font-medium">Learned relevance estimate:</span>
                        <b className="font-mono text-slate-900">{item.relevanceProbability == null ? "Gathering ratings" : `${item.relevanceProbability}%`}</b>
                      </div>
                      <div className="flex items-center justify-between text-slate-600 pt-1">
                        <span className="font-medium">NCF acceptance estimate (ranking contribution {item.ncfInfluence ?? 0}%):</span>
                        <b className="font-mono text-slate-900">{item.ncfAcceptanceProbability == null ? (meta.ncfModel?.active ? "No estimate for this pair" : "Model not published") : `${item.ncfAcceptanceProbability}%`}</b>
                      </div>
                      <p className="text-[11px] leading-relaxed text-slate-500">The ranking score above drives ordering after NCF (when available) and variety adjustments. Profile and member relevance is shown separately; acceptance estimates are not the same as match quality.</p>

                      <div className="flex items-center justify-between text-slate-600 pt-1">
                        <span className="font-medium">Profile &amp; competency overlap:</span>
                        <b className="font-mono text-slate-900">{item.contentScore}%</b>
                      </div>
                      <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-[#0e2740] h-full rounded-full transition-all"
                          style={{ width: `${item.contentScore}%` }}
                        />
                      </div>

                      {/* Signals Chips */}
                      <div className="pt-2 border-t border-slate-200/70">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                          Ranking inputs · NCF share {item.ncfInfluence ?? 0}% · Relevance feedback share {item.relevanceInfluence ?? 0}%
                        </div>
                        <div className="flex flex-wrap gap-1.5 text-[11px]">
                          {[
                            `Skills ${item.signals?.skillOverlap ?? 0}%`,
                            `Interests ${item.signals?.interestOverlap ?? 0}%`,
                            `Profile text alignment ${item.semanticScore ?? 0}%`,
                            item.signals?.sameDepartment ? "Department Match" : "Inter-Department",
                            item.signals?.requestType || "Mentorship",
                            ...(item.diversityAdjustment > 0 ? [`Rank adjusted for variety −${item.diversityAdjustment}%`] : []),
                          ].map((sig) => (
                            <span key={sig} className="px-2.5 py-0.5 rounded-full bg-white border border-slate-200/90 text-slate-600 font-medium">
                              {sig}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold text-slate-800">Based on this profile, is this a relevant match for your goals?</p>
                          <p className="text-[11px] text-slate-500">Rate the suggested match itself. You can rate mentorship usefulness separately after it is completed.</p>
                        </div>
                        <div className="flex gap-2">
                          {[{ rating: 5, label: "Relevant" }, { rating: 1, label: "Not relevant" }].map((choice) => {
                            const saved = recommendationFeedback[item.recommendationId];
                            const selected = saved?.rating === choice.rating;
                            return (
                              <button
                                key={choice.rating}
                                type="button"
                                disabled={saved?.saving}
                                onClick={() => handleRecommendationFeedback(item, choice.rating)}
                                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 ${selected ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"}`}
                              >
                                {saved?.saving ? "Saving…" : selected ? `✓ ${choice.label}` : choice.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {recommendationFeedback[item.recommendationId]?.error && (
                        <p role="alert" className="mt-2 text-[11px] text-red-700">{recommendationFeedback[item.recommendationId].error}</p>
                      )}
                    </div>

                    {/* Shared Skills Chips */}
                    <div>
                      <div className="text-[11px] uppercase font-semibold text-slate-400 mb-2 tracking-wider">Why this match</div>
                      <ul className="space-y-1 mb-3">
                        {(item.matchReasons || []).map((reason) => (
                          <li key={reason} className="text-xs text-slate-600 flex items-start gap-2">
                            <Icon name="check" size={13} className="mt-0.5 text-emerald-700 shrink-0" />
                            <span>{reason}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="text-[11px] uppercase font-semibold text-slate-400 mb-2 tracking-wider">
                        Shared Competencies
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(item.sharedSkills || []).slice(0, 4).map((skill) => (
                          <Tag key={skill} emerald={skill.toLowerCase().includes("flight") || skill.toLowerCase().includes("operations")}>
                            {skill}
                          </Tag>
                        ))}
                        {(!item.sharedSkills || item.sharedSkills.length === 0) && (item.profileRelevancePercent ?? item.matchPercent) === 0 && (
                          <span className="text-xs text-slate-400">No shared skills recorded yet</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="pt-4 border-t border-slate-100 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMatch(item);
                        setRequestMessage(TEMPLATE_MESSAGES[0].text);
                      }}
                      className="flex-1 py-2.5 px-4 rounded-xl bg-[#c8102e] hover:bg-[#a00d24] text-white text-xs font-semibold flex items-center justify-center gap-2 transition shadow-xs cursor-pointer"
                    >
                      <Icon name="requests" size={14} />
                      <span>Request Mentorship</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMatch(item);
                        recordRecommendationEvent(item, "VIEW");
                      }}
                      className="py-2.5 px-4 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                      title="View Profile Details"
                    >
                      <Icon name="eye" size={14} />
                      <span className="hidden sm:inline">Details</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        recordRecommendationEvent(item, "DISMISS");
                        setRecommendations((current) => current.filter((match) => match.userId !== item.userId));
                      }}
                      className="py-2.5 px-3 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-500 text-xs font-semibold transition cursor-pointer"
                      title="Dismiss this recommendation"
                    >
                      Hide
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Mentorship Request Modal */}
        {selectedMatch && (
          <div
            className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4"
            onClick={() => setSelectedMatch(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="mentorship-request-title"
              className="bg-white rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl border border-slate-200 relative"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close Button */}
              <button
                type="button"
                onClick={() => setSelectedMatch(null)}
                aria-label="Close mentorship request"
                className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
              >
                <Icon name="close" size={16} />
              </button>

              {/* Profile Overview */}
              <div className="flex items-start gap-4 pb-4 border-b border-slate-100">
                <Avatar name={selectedMatch.fullName} size="lg" role={selectedMatch.role} />
                <div>
                  <span className="text-xs font-semibold text-[#c8102e]">
                    {ROLE_LABELS[selectedMatch.role] || selectedMatch.role}
                  </span>
                  <h3 id="mentorship-request-title" className="text-lg font-bold text-slate-900">
                    {selectedMatch.fullName}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {selectedMatch.department || "Department not provided"}
                  </p>
                </div>
              </div>

              {/* Bio summary */}
              {selectedMatch.bio && (
                <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-600 leading-relaxed">
                  <b className="text-slate-800">Background:</b> {selectedMatch.bio}
                </div>
              )}

              {/* Feedback Success Alert */}
              {feedbackSuccess && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center gap-2">
                  <Icon name="check" size={16} />
                  <span>{feedbackSuccess}</span>
                </div>
              )}

              {requestError && (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                  {requestError}
                </div>
              )}

              {/* Message Composer */}
              <div className="space-y-2.5">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Mentorship Request Message
                </label>

                {/* Template Quick-Select Pills */}
                <div className="flex flex-wrap gap-1.5">
                  {TEMPLATE_MESSAGES.map((t, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setRequestMessage(t.text)}
                      className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-medium text-slate-700 transition cursor-pointer"
                    >
                      {t.title}
                    </button>
                  ))}
                </div>

                <textarea
                  rows={4}
                  value={requestMessage}
                  onChange={(e) => { setRequestMessage(e.target.value); setRequestError(""); }}
                  placeholder="Introduce yourself, share your current role or aviation aspirations..."
                  className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm outline-none focus:bg-white focus:border-[#c8102e] transition resize-none"
                />
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedMatch(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 transition cursor-pointer"
                >
                  Cancel
                </button>
                <Button
                  onClick={() => handleSendRequest(selectedMatch.userId)}
                  disabled={sendingRequest}
                >
                  {sendingRequest ? "Sending Request..." : "Send Request"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </KQAppShell>
  );
}
