"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import KQAppShell from "@/components/KQAppShell";
import { Avatar, Button } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import { readApiResponse } from "@/lib/read-api-response";

function shortDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-KE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export default function MessagesPage() {
  const { status, data: session } = useSession();
  const router = useRouter();
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState([]);
  const [nextMessageCursor, setNextMessageCursor] = useState(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sentNotice, setSentNotice] = useState("");
  const messagesRequestVersion = useRef(0);
  const messageHistoryRef = useRef(null);

  const loadConversations = useCallback(async () => {
    const response = await fetch("/api/conversations", { cache: "no-store" });
    const data = await readApiResponse(response, "Could not load conversations");
    setConversations(data.conversations || []);
    setSelectedId((current) => {
      if (current && data.conversations?.some((conversation) => conversation.id === current)) return current;
      const requestedId = new URLSearchParams(window.location.search).get("conversationId");
      if (requestedId && data.conversations?.some((conversation) => conversation.id === requestedId)) return requestedId;
      return data.conversations?.[0]?.id || "";
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status !== "authenticated") return;
    let active = true;
    Promise.resolve().then(() => loadConversations()).catch((err) => {
      if (active) { setError(err.message); setLoading(false); }
    });
    return () => { active = false; };
  }, [status, router, loadConversations]);

  const loadMessages = useCallback(async (isActive = () => true) => {
    if (!selectedId) return;
    const requestVersion = ++messagesRequestVersion.current;
    const response = await fetch(`/api/conversations/${selectedId}/messages`, { cache: "no-store" });
    const data = await readApiResponse(response, "Could not load messages");
    // Ignore older polling responses that arrive after a newer fetch or send.
    if (requestVersion === messagesRequestVersion.current && isActive()) {
      setMessages((existing) => {
        const byId = new Map(existing.map((message) => [message.id, message]));
        for (const message of data.messages || []) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      });
      setNextMessageCursor((current) => current || data.nextCursor || null);
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let active = true;
    const refresh = () => loadMessages(() => active).catch((err) => { if (active) setError(err.message); });
    refresh();
    const interval = setInterval(refresh, 12000);
    const url = new URL(window.location.href);
    url.searchParams.set("conversationId", selectedId);
    window.history.replaceState(null, "", url);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedId, loadMessages]);

  const activeConversation = conversations.find((conversation) => conversation.id === selectedId);

  const loadOlderMessages = async () => {
    if (!selectedId || !nextMessageCursor || loadingOlderMessages) return;
    const historyElement = messageHistoryRef.current;
    const previousHeight = historyElement?.scrollHeight || 0;
    const previousScrollTop = historyElement?.scrollTop || 0;
    setLoadingOlderMessages(true);
    setError("");
    try {
      const response = await fetch(`/api/conversations/${selectedId}/messages?before=${encodeURIComponent(nextMessageCursor)}`, { cache: "no-store" });
      const data = await readApiResponse(response, "Could not load older messages");
      setMessages((existing) => {
        const byId = new Map(existing.map((message) => [message.id, message]));
        for (const message of data.messages || []) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      });
      setNextMessageCursor(data.nextCursor || null);
      requestAnimationFrame(() => {
        if (historyElement) historyElement.scrollTop = previousScrollTop + historyElement.scrollHeight - previousHeight;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingOlderMessages(false);
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !selectedId || sending) return;
    setSending(true);
    setError("");
    setSentNotice("");
    messagesRequestVersion.current++;
    try {
      const response = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await readApiResponse(response, "Message could not be sent");
      // Invalidate any poll that started while the POST was in flight so it
      // cannot replace this newly sent message with an older conversation.
      messagesRequestVersion.current++;
      setMessages((items) => items.some((item) => item.id === data.message.id) ? items : [...items, data.message]);
      setConversations((items) => items.map((conversation) => conversation.id === selectedId
        ? { ...conversation, lastMessage: data.message, updatedAt: data.message.createdAt }
        : conversation));
      setDraft("");
      setSentNotice("Message sent");
      window.dispatchEvent(new Event("notifications-updated"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <KQAppShell>
      <div className="app-page messages-page max-w-7xl">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#c8102e]">Member conversations</p>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-950 mt-1">Messages</h1>
            <p className="text-sm text-slate-500 mt-2">Private conversations open after a connection or mentorship request is accepted.</p>
          </div>
          <Link href="/requests" className="text-sm font-semibold text-[#b10e28] hover:underline">View requests →</Link>
        </div>

        {error && <div role="alert" className="messages-alert mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

        <div className="messages-panel grid min-h-[620px] grid-cols-1 grid-rows-[auto_minmax(520px,1fr)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[330px_minmax(0,1fr)] lg:grid-rows-1">
          <aside className="messages-list min-w-0 border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="messages-list-heading border-b border-slate-100 px-5 py-4">
              <h2 className="font-bold text-slate-900">Your connections</h2>
              <p className="mt-1 text-xs text-slate-500">{conversations.length} active {conversations.length === 1 ? "conversation" : "conversations"}</p>
            </div>
            {loading ? (
              <div className="p-6 text-sm text-slate-500">Loading conversations…</div>
            ) : conversations.length ? (
              <div className="max-h-[380px] overflow-y-auto lg:max-h-[560px]">
                {conversations.map((conversation) => {
                  const name = conversation.partner.profile?.fullName || conversation.partner.email;
                  return (
                    <button key={conversation.id} type="button" onClick={() => { setSelectedId(conversation.id); setMessages([]); setNextMessageCursor(null); setSentNotice(""); }} className={`messages-conversation-row flex w-full items-start gap-3 border-b border-slate-100 p-4 text-left transition hover:bg-slate-50 ${selectedId === conversation.id ? "is-active bg-red-50/70" : ""}`}>
                      <Avatar name={name} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <strong className="truncate text-sm text-slate-900">{name}</strong>
                          <small className="shrink-0 text-[10px] text-slate-400">{shortDate(conversation.lastMessage?.createdAt || conversation.updatedAt)}</small>
                        </span>
                        <span className="mt-1 block truncate text-xs text-slate-500">{conversation.lastMessage?.body || conversation.partner.profile?.department || "Start a conversation"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="p-6">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500"><Icon name="requests" size={19} /></div>
                <h3 className="font-bold text-slate-900">No conversations yet</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">Accept a connection or mentorship request to open a private chat with that member.</p>
                <Link href="/directory" className="mt-4 inline-flex text-sm font-bold text-[#b10e28] hover:underline">Explore the directory →</Link>
              </div>
            )}
          </aside>

          <section className="messages-thread flex min-h-[520px] min-w-0 flex-col bg-[#fbfcfd]">
            {activeConversation ? (
              <>
                <header className="messages-thread-header flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
                  <Avatar name={activeConversation.partner.profile?.fullName || activeConversation.partner.email} size="md" />
                  <div className="min-w-0">
                    <h2 className="truncate font-bold text-slate-900">{activeConversation.partner.profile?.fullName || activeConversation.partner.email}</h2>
                    <p className="text-xs text-slate-500">{activeConversation.partner.profile?.department || "PrideConnect member"} · Private chat</p>
                  </div>
                </header>
                <div ref={messageHistoryRef} className="messages-thread-history flex-1 space-y-3 overflow-y-auto p-5" aria-live="polite">
                  {nextMessageCursor && <div className="text-center"><button type="button" onClick={loadOlderMessages} disabled={loadingOlderMessages} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60">{loadingOlderMessages ? "Loading older messages…" : "Load older messages"}</button></div>}
                  {messages.length ? messages.map((message) => {
                    const mine = message.senderId === session?.user?.id;
                    return (
                      <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div className={`messages-bubble max-w-[82%] rounded-2xl px-4 py-3 shadow-sm ${mine ? "messages-bubble-mine rounded-br-md bg-[#102b45] text-white" : "messages-bubble-theirs rounded-bl-md border border-slate-200 bg-white text-slate-800"}`}>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>
                          <time className={`mt-1 block text-right text-[10px] ${mine ? "text-white/60" : "text-slate-400"}`}>{shortDate(message.createdAt)}</time>
                        </div>
                      </div>
                    );
                  }) : <div className="grid h-full min-h-48 place-items-center text-center"><div><div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#b10e28] shadow-sm"><Icon name="requests" size={20} /></div><p className="font-semibold text-slate-700">Start the conversation</p><p className="mt-1 text-sm text-slate-500">Say hello to your new connection.</p></div></div>}
                </div>
                <form onSubmit={sendMessage} className="messages-composer border-t border-slate-200 bg-white p-4 sm:p-5">
                  <label htmlFor="message-body" className="sr-only">Write a message</label>
                  <div className="flex items-end gap-3">
                    <textarea id="message-body" rows={2} maxLength={2000} value={draft} onChange={(event) => { setDraft(event.target.value); setSentNotice(""); }} placeholder="Write a message…" className="min-h-12 flex-1 resize-y rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-[#c8102e] focus:ring-2 focus:ring-red-100" />
                    <Button type="submit" disabled={sending || !draft.trim()} icon="arrow" className="shrink-0 px-5">{sending ? "Sending…" : "Send"}</Button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-[10px]">
                    <p role="status" aria-live="polite" className="text-emerald-700">{sentNotice}</p>
                    <p className="text-slate-400">Up to 2,000 characters</p>
                  </div>
                </form>
              </>
            ) : (
              <div className="grid flex-1 place-items-center p-8 text-center">
                <div><div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500"><Icon name="requests" size={23} /></div><h2 className="text-lg font-bold text-slate-800">Choose a conversation</h2><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Your accepted member connections and mentorships will appear here.</p></div>
              </div>
            )}
          </section>
        </div>
      </div>
    </KQAppShell>
  );
}
