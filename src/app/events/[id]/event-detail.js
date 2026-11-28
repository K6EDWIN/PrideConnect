"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import ReportButton from "@/components/ReportButton";
import { readApiResponse } from "@/lib/read-api-response";

export default function EventDetail({ eventId, returnTo }) {
  const { status } = useSession();
  const router = useRouter();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rsvpPending, setRsvpPending] = useState(false);
  const [rsvpError, setRsvpError] = useState("");
  const [shareNotice, setShareNotice] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`/api/events/${encodeURIComponent(eventId)}`, { signal: controller.signal });
        const data = await readApiResponse(response, "Could not load this event");
        if (!data.event) throw new Error("This event is no longer available.");
        setEvent(data.event);
      } catch (fetchError) {
        if (fetchError.name !== "AbortError") setError(fetchError.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [status, eventId]);

  const toggleRsvp = async () => {
    if (!event) return;
    setRsvpPending(true);
    setRsvpError("");
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(event.id)}/rsvp`, { method: event.isJoined ? "DELETE" : "POST" });
      if (!response.ok) throw new Error((await readApiResponse(response, "Could not update your registration")).error);
      setEvent((current) => ({ ...current, isJoined: !current.isJoined, participantCount: Math.max(0, current.participantCount + (current.isJoined ? -1 : 1)) }));
    } catch (requestError) {
      setRsvpError(requestError.message || "Could not update your registration. Please try again.");
    } finally {
      setRsvpPending(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/events/${encodeURIComponent(eventId)}`);
      setShareNotice("Event link copied.");
    } catch {
      setShareNotice("Copy isn’t available in this browser. You can copy the address from your browser bar.");
    }
  };

  if (status === "loading" || loading) return <KQAppShell><main className="app-page"><div className="card p-10 text-center text-slate-600">Loading event details…</div></main></KQAppShell>;
  if (error || !event) return <KQAppShell><main className="app-page"><div className="card p-8"><p role="alert" className="text-red-700">{error || "This event could not be found."}</p><Link href={returnTo} className="mt-5 inline-flex items-center gap-2 font-semibold text-[#c8102e]"><Icon name="arrow" size={16} /> Back to Events</Link></div></main></KQAppShell>;

  const date = new Date(event.eventDate);
  const isPast = event.isPast || date <= new Date();
  const cover = event.bannerUrl || event.photoUrls?.[0] || "/community-post.svg";
  const gallery = (event.photoUrls || []).filter((url) => url !== cover);

  return <KQAppShell>
    <main className="app-page mx-auto max-w-5xl">
      <Link href={returnTo} className="mb-5 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50"><span aria-hidden="true">←</span> Back to Events</Link>
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="relative aspect-[1200/420] max-h-[420px] min-h-48 overflow-hidden bg-slate-900">
          <Image src={cover} alt={`${event.title} event cover`} fill unoptimized sizes="(max-width: 768px) 100vw, 960px" className="object-cover" priority />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-transparent to-slate-950/10" />
          <span className="absolute bottom-5 left-5 rounded-full border border-white/30 bg-slate-950/55 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white backdrop-blur">Community event</span>
        </div>
        <div className="p-5 sm:p-8">
          <div className="flex flex-col gap-5 border-b border-slate-200 pb-6 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[.16em] text-[#c8102e]">Events &amp; masterclasses</p>
              <h1 className="mt-2 break-words text-3xl font-bold leading-tight text-slate-950 sm:text-4xl">{event.title}</h1>
              <p className="mt-3 text-sm text-slate-600">Organised by <span className="font-semibold text-slate-800">{event.createdByName}</span></p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="secondary" onClick={copyLink} icon="link">Copy event link</Button>
            </div>
          </div>
          {shareNotice && <p role="status" className="mt-3 text-sm text-emerald-700">{shareNotice}</p>}

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <section>
              <h2 className="text-lg font-bold text-slate-900">About this event</h2>
              <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-7 text-slate-700">{event.description || "The organiser has not added a description yet."}</p>
              {!!gallery.length && <div className="mt-8"><h2 className="text-lg font-bold text-slate-900">Event photos</h2><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{gallery.map((url, index) => <Image key={`${url}-${index}`} src={url} alt={`${event.title}, photo ${index + 1}`} width={600} height={400} unoptimized className="aspect-[3/2] w-full rounded-xl object-cover" />)}</div></div>}
              <div className="mt-8"><ReportButton targetType="EVENT" targetId={event.id} /></div>
            </section>
            <aside className="h-fit rounded-xl border border-slate-200 bg-slate-50 p-5">
              <h2 className="text-base font-bold text-slate-900">Event details</h2>
              <dl className="mt-4 space-y-4 text-sm">
                <div><dt className="font-semibold text-slate-500">Date and time</dt><dd className="mt-1 text-slate-800">{date.toLocaleString("en-KE", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Nairobi" })}</dd></div>
                <div><dt className="font-semibold text-slate-500">Venue</dt><dd className="mt-1 break-words text-slate-800">{event.location || "Location to be announced"}</dd></div>
                <div><dt className="font-semibold text-slate-500">Attendees</dt><dd className="mt-1 text-slate-800">{event.participantCount}</dd></div>
              </dl>
              {rsvpError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">{rsvpError}</p>}
              <Button className="mt-5 w-full" variant={event.isJoined ? "secondary" : "primary"} onClick={toggleRsvp} disabled={rsvpPending || (isPast && !event.isJoined)}>{rsvpPending ? "Updating…" : isPast && !event.isJoined ? "Registration closed" : event.isJoined ? "Cancel RSVP" : "Register to attend"}</Button>
              {event.isJoined && <p className="mt-2 text-center text-xs font-medium text-emerald-700">You’re registered for this event.</p>}
            </aside>
          </div>
        </div>
      </article>
    </main>
  </KQAppShell>;
}
