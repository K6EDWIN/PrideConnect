"use client";

import { useEffect, useState, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button, Avatar, Tag } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import { readApiResponse } from "@/lib/read-api-response";

const ROLE_LABELS = {
  ALUMNI: "Pride Centre Alumni",
  STAFF: "Active KQ Staff",
  FORMER_STAFF: "Former KQ Employee",
  FREQUENT_FLYER: "Frequent Flyer",
  ADMIN: "Administrator",
};

export default function RequestsPage() {
  const { status } = useSession();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState("pending"); // pending, sent, active
  const [mentorship, setMentorship] = useState({ sent: [], received: [] });
  const [connections, setConnections] = useState({ sent: [], received: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Rating & Feedback State
  const [ratingTarget, setRatingTarget] = useState(null);
  const [selectedStars, setSelectedStars] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [pendingRequestId, setPendingRequestId] = useState(null);
  const [ratingError, setRatingError] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const refreshRequests = async () => {
    setLoadError("");
    try {
      const [mRes, cRes] = await Promise.all([
        fetch("/api/mentorship-requests"),
        fetch("/api/connection-requests"),
      ]);

      const [mData, cData] = await Promise.all([
        readApiResponse(mRes, "Could not load mentorship requests"),
        readApiResponse(cRes, "Could not load connection requests"),
      ]);
      setMentorship(mData);
      setConnections(cData);
      setLoading(false);
    } catch (error) {
      setLoadError(error.message || "Could not refresh requests. Try again.");
      setLoading(false);
    }
  };

  useEffect(() => {
    if (status !== "authenticated") return;
    let isCurrent = true;

    Promise.all([
      fetch("/api/mentorship-requests"),
      fetch("/api/connection-requests"),
    ])
      .then(async ([mRes, cRes]) => {
        const [mData, cData] = await Promise.all([
          readApiResponse(mRes, "Could not load mentorship requests"),
          readApiResponse(cRes, "Could not load connection requests"),
        ]);
        if (!isCurrent) return;
        setMentorship(mData);
        setConnections(cData);
        setLoading(false);
      })
      .catch((error) => {
        if (!isCurrent) return;
        setLoadError(error.message || "Could not load requests. Try again.");
        setLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [status]);

  const handleRespond = async (kind, id, newStatus) => {
    const endpoint =
      kind === "mentorship"
        ? `/api/mentorship-requests/${id}`
        : `/api/connection-requests/${id}`;

    setActionError("");
    setActionNotice("");
    setPendingRequestId(id);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        setActionNotice(newStatus === "ACCEPTED" ? "Request accepted." : "Request declined.");
        if (newStatus === "ACCEPTED" && kind === "connection") {
          setRatingTarget({ id, kind, role: "Partner" });
        }
        await refreshRequests();
      } else {
        await readApiResponse(res, "Could not update this request");
      }
    } catch (error) {
      setActionError(error.message || "We could not reach the server. Check your connection and try again.");
    } finally {
      setPendingRequestId(null);
    }
  };

  const handleCompleteMentorship = async (req, name) => {
    setActionError("");
    setActionNotice("");
    setPendingRequestId(req.id);
    try {
      const response = await fetch(`/api/mentorship-requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
      const data = await readApiResponse(response, "Could not mark mentorship complete");
      if (!response.ok) {
        setActionError(data.error || "Could not mark mentorship complete. Please try again.");
        return;
      }
      await refreshRequests();
      setRatingTarget({ id: req.id, kind: "mentorship", name });
    } catch (error) {
      setActionError(error.message || "We could not reach the server. Check your connection and try again.");
    } finally {
      setPendingRequestId(null);
    }
  };

  const handleRateSubmit = async () => {
    if (!ratingTarget) return;
    setSubmittingFeedback(true);
    setRatingError("");

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mentorshipRequestId: ratingTarget.kind === "mentorship" ? ratingTarget.id : null,
          connectionRequestId: ratingTarget.kind === "connection" ? ratingTarget.id : null,
          rating: selectedStars,
          comment: feedbackComment || null,
        }),
      });

      if (res.ok) {
        setFeedbackSuccess(true);
        await refreshRequests();
        setTimeout(() => {
          setRatingTarget(null);
          setFeedbackSuccess(false);
          setFeedbackComment("");
        }, 1600);
      } else {
        await readApiResponse(res, "Could not save your rating");
      }
    } catch (error) {
      setRatingError(error.message || "We could not reach the server. Check your connection and try again.");
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const pendingList = useMemo(() => {
    const m = (mentorship.received || [])
      .filter((r) => r.status === "PENDING")
      .map((r) => ({ ...r, kind: "mentorship" }));
    const c = (connections.received || [])
      .filter((r) => r.status === "PENDING")
      .map((r) => ({ ...r, kind: "connection" }));
    return [...m, ...c];
  }, [mentorship, connections]);

  const sentList = useMemo(() => {
    const m = (mentorship.sent || []).map((r) => ({ ...r, kind: "mentorship" }));
    const c = (connections.sent || []).map((r) => ({ ...r, kind: "connection" }));
    return [...m, ...c];
  }, [mentorship, connections]);

  const activeConnectionsList = useMemo(() => {
    const mRec = (mentorship.received || [])
      .filter((r) => r.status === "ACCEPTED")
      .map((r) => ({ ...r, kind: "mentorship", isReceived: true }));
    const mSent = (mentorship.sent || [])
      .filter((r) => r.status === "ACCEPTED")
      .map((r) => ({ ...r, kind: "mentorship", isReceived: false }));
    const cRec = (connections.received || [])
      .filter((r) => r.status === "ACCEPTED")
      .map((r) => ({ ...r, kind: "connection", isReceived: true }));
    const cSent = (connections.sent || [])
      .filter((r) => r.status === "ACCEPTED")
      .map((r) => ({ ...r, kind: "connection", isReceived: false }));
    return [...mRec, ...mSent, ...cRec, ...cSent];
  }, [mentorship, connections]);

  if (status === "loading" || loading) {
    return (
      <KQAppShell>
        <div className="max-w-7xl mx-auto px-6 py-24 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-slate-100 text-[#0e2740] flex items-center justify-center">
            <Icon name="requests" size={24} />
          </div>
          <h2 className="text-xl font-bold text-slate-800">
            Loading Network Requests...
          </h2>
        </div>
      </KQAppShell>
    );
  }

  return (
    <KQAppShell>
      <div className="app-page space-y-6">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[#c8102e] mb-1">
              Mentorship &amp; Connections Hub
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Network Requests
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Manage incoming bilateral invitations and track active mentorship engagements.
            </p>
          </div>

          <Button icon="directory" onClick={() => router.push("/directory")}>
            Explore Directory
          </Button>
        </div>

        {actionError && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{actionError}</div>}
        {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{loadError}</span><Button size="sm" variant="secondary" onClick={() => { setLoading(true); refreshRequests(); }}>Try again</Button></div>}
        {actionNotice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{actionNotice}</div>}

        {/* Tab Switcher */}
        <div className="flex bg-slate-100 p-1 rounded-lg max-w-sm border border-slate-200">
          <button
            type="button"
            onClick={() => setActiveTab("pending")}
            className={`flex-1 py-1.5 px-3 rounded-md text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer ${
              activeTab === "pending"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>Pending</span>
            <span
              className={`px-1.5 py-0.2 rounded text-[11px] font-bold ${
                activeTab === "pending" ? "bg-[#c8102e] text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {pendingList.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("sent")}
            className={`flex-1 py-1.5 px-3 rounded-md text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer ${
              activeTab === "sent"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>Sent</span>
            <span
              className={`px-1.5 py-0.2 rounded text-[11px] font-bold ${
                activeTab === "sent" ? "bg-slate-800 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {sentList.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("active")}
            className={`flex-1 py-1.5 px-3 rounded-md text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer ${
              activeTab === "active"
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>Active</span>
            <span
              className={`px-1.5 py-0.2 rounded text-[11px] font-bold ${
                activeTab === "active" ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-700"
              }`}
            >
              {activeConnectionsList.length}
            </span>
          </button>
        </div>

        {/* Tab 1: Pending Received Requests */}
        {!loadError && activeTab === "pending" && (
          <div className="space-y-4">
            {pendingList.length === 0 ? (
              <div className="card p-12 text-center text-slate-500 space-y-2">
                <Icon name="check" size={28} className="mx-auto text-emerald-600" />
                <h3 className="font-bold text-slate-800 text-base">You are all caught up!</h3>
                <p className="text-sm text-slate-500 max-w-sm mx-auto">
                  No incoming connection or mentorship requests are waiting for your response.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {pendingList.map((req) => {
                  const counterpart = req.sender;
                  const name = counterpart?.profile?.fullName || "Kenya Airways Member";
                  const role = ROLE_LABELS[counterpart?.role] || counterpart?.role || "Stakeholder";

                  return (
                    <div
                      key={req.id}
                      className="card p-5 flex flex-col justify-between space-y-4"
                    >
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
                          <span className="max-w-full truncate text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                            {role}
                          </span>
                          <span className="shrink-0 text-xs text-slate-400">
                            {new Date(req.createdAt).toLocaleDateString()}
                          </span>
                        </div>

                        <div className="flex min-w-0 items-start gap-3">
                          <Avatar name={name} size="md" role={counterpart?.role} />
                          <div className="min-w-0">
                            <h3 className="break-words text-base font-bold text-slate-900">
                              {name}
                            </h3>
                            <span className="text-xs text-[#c8102e] font-semibold">
                              {req.kind === "mentorship" ? "Mentorship Proposal" : "Networking Request"}
                            </span>
                          </div>
                        </div>

                        {req.message && (
                          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-700 leading-relaxed italic">
                            &ldquo;{req.message}&rdquo;
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
                        <button
                          type="button"
                          disabled={pendingRequestId === req.id}
                          onClick={() => handleRespond(req.kind, req.id, "ACCEPTED")}
                          className="flex-1 btn btn-primary text-xs py-2 rounded-md"
                        >
                          <Icon name="check" size={14} />
                          <span>{pendingRequestId === req.id ? "Updating…" : "Accept Request"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={pendingRequestId === req.id}
                          onClick={() => handleRespond(req.kind, req.id, "DECLINED")}
                          className="btn btn-secondary text-xs py-2 px-4 rounded-md"
                        >
                          {pendingRequestId === req.id ? "Updating…" : "Decline"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Sent Requests */}
        {!loadError && activeTab === "sent" && (
          <div className="space-y-4">
            {sentList.length === 0 ? (
              <div className="card p-12 text-center text-slate-500 space-y-2">
                <Icon name="requests" size={28} className="mx-auto text-slate-400" />
                <h3 className="font-bold text-slate-800 text-base">No Sent Requests</h3>
                <p className="text-sm text-slate-500 max-w-sm mx-auto">
                  Browse Smart Matches or the Member Directory to send your first connection invitation.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {sentList.map((req) => {
                  const counterpart = req.receiver;
                  const name = counterpart?.profile?.fullName || "Kenya Airways Member";
                  const role = ROLE_LABELS[counterpart?.role] || counterpart?.role || "Stakeholder";

                  return (
                    <div
                      key={req.id}
                      className="card p-5 flex flex-col justify-between space-y-4"
                    >
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
                          <span className="max-w-full truncate text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                            {role}
                          </span>
                          <span
                            className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded ${
                              req.status === "ACCEPTED"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : req.status === "DECLINED"
                                ? "bg-red-50 text-red-600 border border-red-200"
                                : "bg-amber-50 text-amber-700 border border-amber-200"
                            }`}
                          >
                            {req.status}
                          </span>
                        </div>

                        <div className="flex min-w-0 items-start gap-3">
                          <Avatar name={name} size="md" role={counterpart?.role} />
                          <div className="min-w-0">
                            <h3 className="break-words text-base font-bold text-slate-900">
                              {name}
                            </h3>
                            <span className="text-xs text-slate-400">
                              Sent on {new Date(req.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>

                        {req.message && (
                          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-700 leading-relaxed italic">
                            &ldquo;{req.message}&rdquo;
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Active Connections */}
        {!loadError && activeTab === "active" && (
          <div className="space-y-4">
            {activeConnectionsList.length === 0 ? (
              <div className="card p-12 text-center text-slate-500 space-y-2">
                <Icon name="users" size={28} className="mx-auto text-slate-400" />
                <h3 className="font-bold text-slate-800 text-base">No Active Connections Yet</h3>
                <p className="text-sm text-slate-500 max-w-sm mx-auto">
                  When a request is accepted, your bilateral connection will appear here.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {activeConnectionsList.map((req) => {
                  const counterpart = req.isReceived ? req.sender : req.receiver;
                  const name = counterpart?.profile?.fullName || "Kenya Airways Member";
                  const role = ROLE_LABELS[counterpart?.role] || counterpart?.role || "Stakeholder";

                  return (
                    <div
                      key={req.id}
                      className="card p-5 space-y-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
                        <span className="max-w-full truncate text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                          {role}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                          Active Connection
                        </span>
                      </div>

                      <div className="flex min-w-0 items-start gap-3">
                        <Avatar name={name} size="md" role={counterpart?.role} />
                        <div className="min-w-0">
                          <h3 className="break-words text-base font-bold text-slate-900">
                            {name}
                          </h3>
                          <p className="text-xs text-slate-400">
                            Connected since {new Date(req.updatedAt || req.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                        {req.kind === "mentorship" ? (
                          req.completedAt && req.feedback?.length ? (
                            <p className="w-full text-center text-xs text-emerald-700">Completed · you rated this mentorship {req.feedback[0].rating}/5</p>
                          ) : (
                            <button
                              type="button"
                              onClick={() => req.completedAt
                                ? setRatingTarget({ id: req.id, kind: "mentorship", name })
                                : handleCompleteMentorship(req, name)}
                              disabled={pendingRequestId === req.id}
                              className="btn btn-secondary text-xs py-2 w-full rounded-md disabled:cursor-wait disabled:opacity-60"
                            >
                              <Icon name={req.completedAt ? "star" : "check"} size={14} className="text-[#c59b27]" />
                              <span>{req.completedAt ? "Rate mentorship usefulness" : "Mark mentorship complete & rate"}</span>
                            </button>
                          )
                        ) : (
                          <button
                            type="button"
                            onClick={() => setRatingTarget({ id: req.id, kind: req.kind, name })}
                            className="btn btn-secondary text-xs py-2 w-full rounded-md"
                          >
                            <Icon name="star" size={14} className="text-[#c59b27]" />
                            <span>Rate Connection Quality</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Rating Modal */}
        {ratingTarget && (
          <div
            className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
            onClick={() => setRatingTarget(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="request-feedback-title"
              className="bg-white rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl border border-slate-200 text-center relative"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setRatingTarget(null)}
                aria-label="Close feedback dialog"
                className="absolute top-4 right-4 p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              >
                <Icon name="close" size={16} />
              </button>

              <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 text-[#c59b27] flex items-center justify-center">
                <Icon name="star" size={24} />
              </div>

              <div>
                <h3 id="request-feedback-title" className="text-lg font-bold text-slate-900">
                  {ratingTarget.kind === "mentorship" ? "Rate this mentorship" : "Rate Connection Quality"}
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto leading-relaxed">
                  {ratingTarget.kind === "mentorship"
                    ? "How useful was this mentorship for your goals? Your rating helps improve future mentor matches."
                    : "Your feedback helps improve future connection recommendations."}
                </p>
              </div>

              {feedbackSuccess ? (
                <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-2">
                  <Icon name="check" size={16} />
                  <span>Feedback Saved! Collaborative weights updated.</span>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Star Rating */}
                  <div className="flex items-center justify-center gap-2 py-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setSelectedStars(star)}
                        aria-pressed={star === selectedStars}
                        className="p-1 transition cursor-pointer"
                        aria-label={`Rate ${star} stars`}
                      >
                        <Icon
                          name="star"
                          size={24}
                          className={
                            star <= selectedStars ? "text-[#c59b27]" : "text-slate-300"
                          }
                        />
                      </button>
                    ))}
                  </div>

                  {ratingError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-left text-xs text-red-800">{ratingError}</p>}

                  <textarea
                    rows={3}
                    value={feedbackComment}
                    onChange={(e) => setFeedbackComment(e.target.value)}
                    placeholder="Optional feedback: Did this connection meet your professional expectations?"
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-md text-xs sm:text-sm outline-none focus:bg-white focus:border-[#c8102e] resize-none"
                  />

                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setRatingTarget(null)}
                      className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      Skip
                    </button>
                    <Button onClick={handleRateSubmit} disabled={submittingFeedback}>
                      {submittingFeedback ? "Saving..." : "Submit Rating"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </KQAppShell>
  );
}
