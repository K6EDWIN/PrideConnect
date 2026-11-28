"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button, Tag } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import ReportButton from "@/components/ReportButton";
import { readApiResponse } from "@/lib/read-api-response";

function EventsLoading() {
  return <KQAppShell><div className="app-page"><div className="card p-10 text-center text-slate-600">Loading events…</div></div></KQAppShell>;
}

export default function EventsPage() {
  return <Suspense fallback={<EventsLoading />}><EventsContent /></Suspense>;
}

function EventsContent() {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sharedEventId = searchParams.get("eventId") || "";

  const [events, setEvents] = useState([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [page, setPage] = useState(() => Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1));
  const [totalPages, setTotalPages] = useState(1);
  const [eventsReloadKey, setEventsReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    title: "",
    description: "",
    location: "",
    eventDate: "",
    bannerUrl: "",
    photoUrls: [],
  });
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState("");
  const [postNotice, setPostNotice] = useState("");
  const [rsvpPendingId, setRsvpPendingId] = useState(null);
  const [rsvpError, setRsvpError] = useState("");
  const [bannerUploading, setBannerUploading] = useState(false);
  const [bannerError, setBannerError] = useState("");
  const [bannerName, setBannerName] = useState("");
  const [editingEventId, setEditingEventId] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [photoNames, setPhotoNames] = useState([]);
  const [shareEvent, setShareEvent] = useState(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareError, setShareError] = useState("");
  const [highlightedEventId, setHighlightedEventId] = useState("");
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  const [timeFilter, setTimeFilter] = useState(() => searchParams.get("time") || (searchParams.has("eventId") ? "all" : "upcoming"));
  const [formatFilter, setFormatFilter] = useState(() => searchParams.get("format") || "");

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: search, time: timeFilter, format: formatFilter, page: String(page) });
        if (sharedEventId) params.set("eventId", sharedEventId);
        const res = await fetch(`/api/events?${params}`, { signal: controller.signal });
        const data = await readApiResponse(res, "Could not load events");

        setEvents(data.events || []);
        setEventsTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(err.message);
          setLoading(false);
        }
      }
    }, search ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [status, search, timeFilter, formatFilter, page, eventsReloadKey, sharedEventId]);

  const eventReturnTo = (() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (timeFilter !== "upcoming") params.set("time", timeFilter);
    if (formatFilter) params.set("format", formatFilter);
    if (page > 1) params.set("page", String(page));
    return `/events${params.size ? `?${params}` : ""}`;
  })();

  useEffect(() => {
    if (!events.length || typeof window === "undefined") return;
    const eventId = new URLSearchParams(window.location.search).get("eventId");
    if (!eventId || !events.some((event) => event.id === eventId)) return;
    const highlightFrame = window.requestAnimationFrame(() => setHighlightedEventId(eventId));
    const scrollTimer = window.setTimeout(() => document.getElementById(`event-${eventId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => {
      window.cancelAnimationFrame(highlightFrame);
      window.clearTimeout(scrollTimer);
    };
  }, [events]);

  useEffect(() => {
    if (!shareEvent) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setShareEvent(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [shareEvent]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const handleBannerChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBannerError("");
    setBannerName("");
    setBannerUploading(true);
    try {
      const formData = new FormData();
      formData.append("banner", file);
      if (editingEventId) formData.append("eventId", editingEventId);
      const response = await fetch("/api/events/banner", { method: "POST", body: formData });
      const data = await readApiResponse(response, "Could not upload event banner");
      setForm((current) => ({ ...current, bannerUrl: data.url }));
      setBannerName(file.name);
    } catch (err) {
      setBannerError(err.message);
      e.target.value = "";
    } finally {
      setBannerUploading(false);
    }
  };

  const handlePhotoGalleryChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (form.photoUrls.length + files.length > 8) {
      setPhotoError("An event can have up to eight gallery photos.");
      e.target.value = "";
      return;
    }
    setPhotoError("");
    setPhotoUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("photos", file);
        if (editingEventId) formData.append("eventId", editingEventId);
        const response = await fetch("/api/events/banner", { method: "POST", body: formData });
        const data = await readApiResponse(response, "Could not upload event photos");
        if (!Array.isArray(data.urls) || data.urls.length !== 1) throw new Error(`Could not upload ${file.name}.`);
        setForm((current) => ({ ...current, photoUrls: [...current.photoUrls, data.urls[0]] }));
        setPhotoNames((current) => [...current, file.name]);
      }
      e.target.value = "";
    } catch (err) {
      setPhotoError(err.message);
      e.target.value = "";
    } finally {
      setPhotoUploading(false);
    }
  };

  const beginEdit = (event) => {
    const localDate = new Date(event.eventDate);
    localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
    setEditingEventId(event.id);
    setForm({
      title: event.title || "",
      description: event.description || "",
      location: event.location || "",
      eventDate: localDate.toISOString().slice(0, 16),
      bannerUrl: event.bannerUrl || "",
      photoUrls: event.photoUrls || [],
    });
    setPhotoNames([]);
    setPostError("");
    setPostNotice("");
    document.getElementById("event-post")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cancelEdit = () => {
    setEditingEventId("");
    setForm({ title: "", description: "", location: "", eventDate: "", bannerUrl: "", photoUrls: [] });
    setBannerName("");
    setPhotoNames([]);
    setPostError("");
    setPostNotice("");
  };

  const shareEventLink = async (event, copyOnly = false) => {
    const url = new URL(`/events/${encodeURIComponent(event.id)}`, window.location.origin);
    try {
      if (!copyOnly && navigator.share) {
        await navigator.share({ title: event.title, text: event.description || "Join this PrideConnect event.", url: url.toString() });
        return;
      }
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(true);
      setShareError("");
    } catch (error) {
      if (error.name !== "AbortError") {
        setShareCopied(false);
        setShareError("Copy didn’t work here. Select the link and copy it manually.");
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setPosting(true);
    setPostError("");
    setPostNotice("");

    try {
      const res = await fetch(editingEventId ? `/api/events/${editingEventId}` : "/api/events", {
        method: editingEventId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await readApiResponse(res, "Could not create event");

      setPosting(false);

      setSearch("");
      setTimeFilter("upcoming");
      setFormatFilter("");
      setPage(1);
      setEventsReloadKey((key) => key + 1);
      setForm({ title: "", description: "", location: "", eventDate: "", bannerUrl: "", photoUrls: [] });
      setBannerName("");
      setPhotoNames([]);
      setEditingEventId("");
      setPostNotice(editingEventId ? "Event changes saved." : "Event published. Member email announcements are being sent in the background.");
    } catch (err) {
      setPosting(false);
      setPostError(err.message);
    }
  };

  const toggleRsvp = async (eventId, currentlyJoined) => {
    setRsvpPendingId(eventId);
    setRsvpError("");

    try {
      const res = await fetch(`/api/events/${eventId}/rsvp`, {
        method: currentlyJoined ? "DELETE" : "POST",
      });

      setRsvpPendingId(null);

      if (!res.ok) {
        const data = await readApiResponse(res, "Could not update your RSVP");
        setRsvpError(data.error || "Could not update your RSVP. Please try again.");
        return;
      }

      setEvents((prev) =>
        prev.map((e) =>
          e.id === eventId
            ? {
                ...e,
                isJoined: !currentlyJoined,
                participantCount: e.participantCount + (currentlyJoined ? -1 : 1),
              }
            : e
        )
      );
    } catch (error) {
      setRsvpError(error.message || "We could not reach the server. Check your connection and try again.");
    } finally {
      setRsvpPendingId(null);
    }
  };

  const visibleEvents = events;

  if (status === "loading" || loading) {
    return (
      <KQAppShell>
        <div className="app-page">
          <div className="p-12 text-center text-gray-500 font-medium">
            <Icon name="events" size={28} className="mx-auto mb-3 text-[#bb162b] animate-spin" />
            Loading aviation events and masterclasses...
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
            <div className="eyebrow">COMMUNITY &amp; LEARNING</div>
            <h1>Aviation Events &amp; Masterclasses</h1>
            <p>
              Pride Centre seminars, crew workshops, alumni reunions, and technical masterclasses.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <a href="#event-list" className="rounded-lg bg-[#c8102e] px-4 py-2 text-center text-sm font-semibold text-white hover:bg-[#a90d27]">Explore events</a>
            <a href="#event-post" className="rounded-lg border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50">Post an event</a>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-12">
          {/* Create an Event Card */}
          <section id="event-post" className="order-2 scroll-mt-24">
            <div className="mb-4">
              <div className="eyebrow">CONTRIBUTE TO THE COMMUNITY</div>
              <h2 className="text-2xl font-bold text-slate-900">Events Post</h2>
              <p className="mt-1 text-sm text-slate-600">Create an event, add a banner, and invite members to RSVP.</p>
            </div>
            <form
              onSubmit={handleSubmit}
              className="card max-w-4xl p-6 space-y-4"
            >
              <div className="flex items-center gap-3 pb-3 border-b border-slate-100">
                <span className="p-2 bg-[#c8102e]/10 text-[#c8102e] rounded-lg">
                  <Icon name="events" size={16} />
                </span>
                <div>
                  <h2 className="font-bold text-slate-900 text-sm">{editingEventId ? "Edit Event" : "Create an Event"}</h2>
                  <p className="text-slate-500 text-xs">{editingEventId ? "Update the details, banner, or photo gallery" : "Host an aviation seminar or reunion"}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label htmlFor="event-title" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Event Title
                  </label>
                  <input
                    name="title"
                    id="event-title"
                    placeholder="e.g. B787 Dreamliner Systems Masterclass"
                    value={form.title}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="event-description" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Description
                  </label>
                  <textarea
                    name="description"
                    id="event-description"
                    placeholder="Agenda, keynote speakers, and learning objectives..."
                    value={form.description}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                    rows={3}
                    required
                  />
                </div>

                <div>
                  <label htmlFor="event-location" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Location / Platform
                  </label>
                  <input
                    name="location"
                    id="event-location"
                    placeholder="e.g. Pride Centre Auditorium, Nairobi (or Teams link)"
                    value={form.location}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="event-date" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Date &amp; Time
                  </label>
                  <input
                    type="datetime-local"
                    name="eventDate"
                    id="event-date"
                    value={form.eventDate}
                    onChange={handleChange}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition text-slate-800"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="event-banner" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">Event Banner <span className="font-normal normal-case text-slate-500">(optional)</span></label>
                  <input id="event-banner" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleBannerChange} disabled={bannerUploading || posting} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-semibold file:text-slate-700 hover:file:bg-slate-200" aria-describedby="event-banner-help" />
                  <p id="event-banner-help" className="mt-1 text-xs text-slate-500">JPG, PNG or WebP, up to 4 MB. It appears on the event and announcement email.</p>
                  {bannerUploading && <p role="status" className="mt-2 text-xs text-slate-600">Uploading banner…</p>}
                  {bannerName && <p role="status" className="mt-2 text-xs text-emerald-700">Banner ready: {bannerName}</p>}
                  {bannerError && <p role="alert" className="mt-2 text-xs text-red-700">{bannerError}</p>}
                  {form.bannerUrl && <Image src={form.bannerUrl} alt="Preview of event banner" width={1280} height={640} unoptimized className="mt-3 max-h-40 w-full rounded-lg border border-slate-200 object-cover" />}
                  {form.bannerUrl && editingEventId && <button type="button" onClick={() => { setForm((current) => ({ ...current, bannerUrl: "" })); setBannerName(""); }} className="mt-2 text-xs font-semibold text-red-700 hover:underline">Remove current banner</button>}
                </div>

                <div>
                  <label htmlFor="event-gallery" className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">Additional event photos <span className="font-normal normal-case text-slate-500">(optional, up to 8)</span></label>
                  <input id="event-gallery" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={handlePhotoGalleryChange} disabled={photoUploading || posting || form.photoUrls.length >= 8} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-semibold file:text-slate-700 hover:file:bg-slate-200" aria-describedby="event-gallery-help" />
                  <p id="event-gallery-help" className="mt-1 text-xs text-slate-500">Add a few moments, speakers, or venue photos. JPG, PNG, or WebP, up to 4 MB each.</p>
                  {photoUploading && <p role="status" className="mt-2 text-xs text-slate-600">Uploading event photos…</p>}
                  {photoError && <p role="alert" className="mt-2 text-xs text-red-700">{photoError}</p>}
                  {!!photoNames.length && <p role="status" className="mt-2 text-xs text-emerald-700">Uploaded: {photoNames.join(", ")}</p>}
                  {!!form.photoUrls.length && <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {form.photoUrls.map((url, index) => <div key={`${url}-${index}`} className="relative">
                      <Image src={url} alt={`Event photo ${index + 1}`} width={480} height={320} unoptimized className="h-24 w-full rounded-lg border border-slate-200 object-cover" />
                      <button type="button" onClick={() => setForm((current) => ({ ...current, photoUrls: current.photoUrls.filter((_, photoIndex) => photoIndex !== index) }))} className="absolute right-1 top-1 rounded-full bg-slate-950/80 px-2 py-1 text-xs font-bold text-white" aria-label={`Remove event photo ${index + 1}`}>×</button>
                    </div>)}
                  </div>}
                </div>

                {postError && (
                  <p role="alert" className="text-red-700 text-xs bg-red-50 border border-red-200 p-2.5 rounded-lg">
                    {postError}
                  </p>
                )}
                {postNotice && <p role="status" className={`text-xs p-2.5 rounded-lg ${postNotice.startsWith("Event published, but") ? "text-amber-900 bg-amber-50 border border-amber-200" : "text-emerald-800 bg-emerald-50 border border-emerald-200"}`}>{postNotice}</p>}

                <Button
                  type="submit"
                  disabled={posting || bannerUploading || photoUploading}
                  className="w-full"
                  icon="arrow"
                >
                  {posting ? (editingEventId ? "Saving changes…" : "Scheduling…") : (editingEventId ? "Save Event Changes" : "Schedule Event")}
                </Button>
                {editingEventId && <Button type="button" variant="secondary" className="w-full" onClick={cancelEdit}>Cancel editing</Button>}
              </div>
            </form>
          </section>

          {/* List of Events */}
          <section id="event-list" className="order-1 space-y-5 scroll-mt-24">
            <div className="flex flex-col gap-1 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="eyebrow">DISCOVER COMMUNITY &amp; LEARNING</div>
                <h2 className="text-2xl font-bold text-slate-900">Events Available</h2>
                <p className="mt-1 text-sm text-slate-600">Find upcoming aviation events, view details, and RSVP.</p>
              </div>
              <span className="text-sm font-semibold text-slate-600">{eventsTotal} {eventsTotal === 1 ? "event" : "events"}</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Community Events ({eventsTotal})
              </span>
              {totalPages > 1 && <span className="text-xs font-semibold text-slate-500">Page {page} of {totalPages}</span>}
            </div>

            <div className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              <input aria-label="Search events" type="search" value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Search event, topic, or location…" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 sm:col-span-2" />
              <select aria-label="Filter events by date" value={timeFilter} onChange={(event) => { setPage(1); setTimeFilter(event.target.value); }} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"><option value="upcoming">Upcoming events</option><option value="past">Past events</option><option value="all">All dates</option></select>
              <select aria-label="Filter by event format" value={formatFilter} onChange={(event) => { setPage(1); setFormatFilter(event.target.value); }} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"><option value="">All formats</option><option value="inperson">In person</option><option value="online">Online</option></select>
            </div>

            {rsvpError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{rsvpError}</p>}

            {error ? (
              <p className="text-red-600 text-sm">{error}</p>
            ) : events.length === 0 ? (
              <div className="p-12 text-center card text-slate-500">
                {search || formatFilter || timeFilter !== "upcoming"
                  ? "No events match these filters. Try a different search or date range."
                  : "No upcoming events are scheduled yet. Create an event to gather peers and mentees!"}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {visibleEvents.map((e) => {
                  const d = new Date(e.eventDate);
                  const isPast = e.isPast || d <= new Date();
                  const isPending = rsvpPendingId === e.id;

                  return (
                    <article
                      key={e.id}
                      id={`event-${e.id}`}
                      className={`card overflow-hidden p-5 transition ${highlightedEventId === e.id ? "border-[#c8102e] ring-2 ring-[#c8102e]/20" : "hover:border-slate-300"}`}
                    >
                <Link href={`/events/${encodeURIComponent(e.id)}?returnTo=${encodeURIComponent(eventReturnTo)}`} className="-mx-5 -mt-5 mb-4 block aspect-[1200/420] overflow-hidden bg-slate-900" aria-label={`View details for ${e.title}`}>
                        <Image src={e.bannerUrl || e.photoUrls?.[0] || "/community-post.svg"} alt={`${e.title} event cover`} width={1200} height={420} unoptimized className="h-full w-full object-cover transition duration-300 hover:scale-[1.02]" />
                      </Link>
                      {!!e.photoUrls?.length && <div className="-mx-1 mb-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {e.photoUrls.filter((url) => url !== (e.bannerUrl || e.photoUrls?.[0])).map((url, index) => <Image key={`${url}-${index}`} src={url} alt={`${e.title}, event photo ${index + 1}`} width={480} height={320} unoptimized className="h-20 w-full rounded-lg object-cover sm:h-24" />)}
                      </div>}
                      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-base text-slate-900"><Link href={`/events/${encodeURIComponent(e.id)}?returnTo=${encodeURIComponent(eventReturnTo)}`} className="hover:text-[#a30d25]">{e.title}</Link></h3>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mt-1">
                            <span className="flex items-center gap-1">
                              <Icon name="calendar" size={12} />
                              {d.toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            <span>·</span>
                            <span className="min-w-0 break-words">{e.location}</span>
                          </div>
                        </div>
                        <Tag gold={e.isJoined} className="shrink-0">
                          {e.participantCount} {e.participantCount === 1 ? "attendee" : "attendees"}
                        </Tag>
                      </div>

                      <p className="text-sm text-slate-700 leading-relaxed mt-3 whitespace-pre-wrap">
                        {e.description}
                      </p>

                      <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 flex-1 text-slate-500">
                          Organized by {e.createdByName}
                        </span>

                        <Button
                          variant={e.isJoined ? "secondary" : "primary"}
                          onClick={() => toggleRsvp(e.id, e.isJoined)}
                          disabled={isPending || (isPast && !e.isJoined)}
                          className="text-xs py-1.5 px-3 min-h-0 w-full sm:w-auto"
                        >
                          {isPast && !e.isJoined ? "Registration closed" : isPending
                            ? "Updating..."
                            : e.isJoined
                            ? "Cancel RSVP"
                            : "RSVP to Attend"}
                        </Button>
                        <Link href={`/events/${encodeURIComponent(e.id)}?returnTo=${encodeURIComponent(eventReturnTo)}`} className="rounded-lg bg-[#c8102e] px-3 py-2 text-center font-semibold text-white hover:bg-[#a30d25]">View details</Link>
                        <button type="button" onClick={() => { setShareEvent(e); setShareCopied(false); setShareError(""); }} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-center font-semibold text-slate-700 hover:border-[#c8102e]/40 hover:bg-red-50 hover:text-[#a30d25]">
                          <Icon name="link" size={15} /> Share link
                        </button>
                        {e.canManage && <button type="button" onClick={() => beginEdit(e)} className="rounded-lg border border-slate-300 px-3 py-2 text-center font-semibold text-slate-700 hover:bg-slate-50">Edit event</button>}
                      </div>
                      <ReportButton targetType="EVENT" targetId={e.id} />
                    </article>
                  );
                })}
              </div>
            )}
            {totalPages > 1 && <nav aria-label="Event pages" className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
            </nav>}
          </section>
        </div>
      </div>
      {shareEvent && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareEvent(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="share-event-title" className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div><p className="text-xs font-bold uppercase tracking-wider text-[#c8102e]">Share with your network</p><h2 id="share-event-title" className="mt-1 text-lg font-bold text-slate-900">Share this event</h2></div>
            <button type="button" onClick={() => setShareEvent(null)} className="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100" aria-label="Close share dialog"><Icon name="close" size={18} /></button>
          </div>
          <div className="p-5">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              {shareEvent.bannerUrl || shareEvent.photoUrls?.[0]
                ? <Image src={shareEvent.bannerUrl || shareEvent.photoUrls[0]} alt={`${shareEvent.title} event image`} width={960} height={400} unoptimized className="h-44 w-full object-cover" />
                : <Image src="/community-post.svg" alt="Community event" width={960} height={400} unoptimized className="h-44 w-full object-cover" />}
              <div className="p-4"><h3 className="font-bold text-slate-900">{shareEvent.title}</h3><p className="mt-1 line-clamp-2 text-sm text-slate-600">{shareEvent.description}</p><p className="mt-3 text-xs font-medium text-slate-500">{new Date(shareEvent.eventDate).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {shareEvent.location || "Location to be announced"}</p></div>
            </div>
            <label htmlFor="share-event-url" className="mt-5 block text-xs font-semibold text-slate-700">Event link</label>
            <div className="mt-1 flex gap-2"><input id="share-event-url" readOnly value={typeof window !== "undefined" ? `${window.location.origin}/events/${encodeURIComponent(shareEvent.id)}` : ""} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-700" /><button type="button" onClick={() => shareEventLink(shareEvent, true)} className="shrink-0 rounded-lg bg-[#c8102e] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#a30d25]">{shareCopied ? "Copied" : "Copy link"}</button></div>
            {shareError && <p role="alert" className="mt-2 text-xs text-amber-800">{shareError}</p>}
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setShareEvent(null)} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Done</button><button type="button" onClick={() => shareEventLink(shareEvent)} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Share…</button></div>
          </div>
        </section>
      </div>}
    </KQAppShell>
  );
}
