"use client";

import { Fragment, useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button, Avatar } from "@/components/KQBrand";
import { Icon, GoogleIcon } from "@/components/KQIcons";
import { readApiResponse } from "@/lib/read-api-response";
import TwoFactorSettings from "@/components/TwoFactorSettings";
import {
  AVAILABILITY_DAYS,
  buildAvailabilityText,
  createAvailabilityDraft,
  describeAvailability,
} from "@/lib/availability";

const ROLE_OPTIONS = [
  { value: "", label: "Not participating in mentorship" },
  { value: "MENTOR", label: "Available to Mentor" },
  { value: "MENTEE", label: "Seeking a Mentor" },
  { value: "BOTH", label: "Open to Both (Mentor & Mentee)" },
];

export default function ProfileEditor({ adminWorkspace = false, standalone = false }) {
  const { status, data: session } = useSession();
  const router = useRouter();
  const isAdmin = session?.user?.role === "ADMIN";

  const [meta, setMeta] = useState({ skills: [], interests: [] });
  const [form, setForm] = useState({
    fullName: "",
    bio: "",
    department: "",
    professionalBackground: "",
    trainingHistory: "",
    careerGoals: "",
    mentorshipNeeds: "",
    mentorshipRole: "",
    availability: "",
    isPublic: true,
    skillIds: [],
    interestIds: [],
    seekingTopicIds: [],
    offeringTopicIds: [],
  });
  const [availabilityDraft, setAvailabilityDraft] = useState(() => createAvailabilityDraft(""));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [avatarSrc, setAvatarSrc] = useState(null);
  const avatarStorageKey = session?.user?.id ? `kq_user_avatar:${session.user.id}` : null;
  const interpretedAvailability = describeAvailability(form.availability);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = avatarStorageKey ? localStorage.getItem(avatarStorageKey) : null;
        setAvatarSrc(stored || session?.user?.image || null);
      } catch {
        setAvatarSrc(session?.user?.image || null);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [avatarStorageKey, session?.user?.image]);

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > 5 * 1024 * 1024) {
      setError("Image file size must be less than 5MB");
      return;
    }
    if (!avatarStorageKey) {
      setError("Sign in again before changing your profile photo.");
      return;
    }

    try {
      const image = await createImageBitmap(file);
      const scale = Math.min(1, 512 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Your browser could not prepare that image.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close?.();
      const dataUrl = canvas.toDataURL("image/webp", 0.82);
      setAvatarSrc(dataUrl);
      localStorage.setItem(avatarStorageKey, dataUrl);
      window.dispatchEvent(new Event("kq-avatar-updated"));
      setMessage("Profile photo updated on this device.");
      setError("");
    } catch (uploadError) {
      setError(uploadError?.name === "QuotaExceededError"
        ? "This browser is out of storage space. Remove an older profile photo and try again."
        : uploadError.message || "Could not read that image. Try a JPG, PNG, or WebP file.");
    }
  };

  const handleUseGooglePhoto = () => {
    if (!session?.user?.image || !avatarStorageKey) {
      setError("A Google profile photo is not available for this sign-in.");
      return;
    }
    try {
      localStorage.removeItem(avatarStorageKey);
      setAvatarSrc(session.user.image);
      window.dispatchEvent(new Event("kq-avatar-updated"));
      setMessage("Using your Google profile photo.");
      setError("");
    } catch {
      setError("Could not update your profile photo in this browser.");
    }
  };

  const handleRemovePhoto = () => {
    try {
      if (avatarStorageKey) localStorage.removeItem(avatarStorageKey);
      setAvatarSrc(session?.user?.image || null);
      window.dispatchEvent(new Event("kq-avatar-updated"));
      setMessage(session?.user?.image ? "Using your Google profile photo." : "Profile picture reset to initials.");
      setError("");
    } catch {
      setError("Could not remove the saved profile photo in this browser.");
    }
  };

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated" && isAdmin && !adminWorkspace) {
      router.replace("/admin/profile");
    }
  }, [status, isAdmin, adminWorkspace, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    async function load() {
      try {
        const [metaRes, profileRes] = await Promise.all([
          fetch("/api/meta"),
          fetch("/api/profile"),
        ]);

        const metaData = await readApiResponse(metaRes, "Could not load profile options");
        setMeta(metaData);

        const { profile } = await readApiResponse(profileRes, "Could not load your profile");
        setAvailabilityDraft(createAvailabilityDraft(profile.availability || ""));
        setForm((f) => ({
          ...f,
          fullName: profile.fullName || "",
          bio: profile.bio || "",
          department: profile.department || "",
          professionalBackground: profile.professionalBackground || "",
          trainingHistory: profile.trainingHistory || "",
          careerGoals: profile.careerGoals || "",
          mentorshipNeeds: profile.mentorshipNeeds || "",
          mentorshipRole: profile.mentorshipRole || "",
          availability: profile.availability || "",
          isPublic: profile.isPublic ?? true,
          skillIds: profile.skillIds || [],
          interestIds: profile.interestIds || [],
          seekingTopicIds: profile.seekingTopicIds || [],
          offeringTopicIds: profile.offeringTopicIds || [],
        }));
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }

    load();
  }, [status]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const updateAvailabilityDraft = (nextDraft) => {
    setAvailabilityDraft(nextDraft);
    setForm((current) => ({ ...current, availability: buildAvailabilityText(nextDraft) }));
  };

  const toggleAvailabilityDay = (day) => {
    const days = availabilityDraft.days.includes(day)
      ? availabilityDraft.days.filter((value) => value !== day)
      : [...availabilityDraft.days, day];
    updateAvailabilityDraft({ ...availabilityDraft, days });
  };

  const toggleId = (key, id) => {
    setForm((f) => {
      const current = f[key];
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id];
      return { ...f, [key]: next };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    if (!availabilityDraft.fullDay && Boolean(availabilityDraft.startTime) !== Boolean(availabilityDraft.endTime)) {
      setError("Choose both a start time and an end time, or select full-day availability.");
      setSaving(false);
      return;
    }
    if (availabilityDraft.startTime && availabilityDraft.startTime === availabilityDraft.endTime) {
      setError("Start and end time must be different.");
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await readApiResponse(res, "Could not save your profile");
      setSaving(false);

      if (!res.ok) {
        setError(data.error || "Failed to save profile");
        return;
      }

      setMessage("Your profile & matching vectors have been updated.");
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  };

  const handleDeleteAccount = async () => {
    if (!window.confirm("Delete your account? Your profile will be anonymized, and this action cannot be undone.")) return;
    setDeletingAccount(true);
    setError("");
    try {
      const response = await fetch("/api/account", { method: "DELETE" });
      const data = await readApiResponse(response, "Could not delete your account");
      if (!response.ok) throw new Error(data.error || "Could not delete account");
      try {
        if (avatarStorageKey) localStorage.removeItem(avatarStorageKey);
      } catch {
        // Local avatar cleanup is best effort; server-side account deletion has already succeeded.
      }
      await signOut({ callbackUrl: "/login" });
    } catch (deleteError) {
      setError(deleteError.message || "Could not delete account");
      setDeletingAccount(false);
    }
  };

  if (status === "loading" || loading) {
    if (status === "authenticated" && isAdmin && !adminWorkspace) return null;

    const Shell = adminWorkspace || standalone ? Fragment : KQAppShell;
    return (
      <Shell>
        <div className="app-page">
          <div className="p-12 text-center text-gray-500 font-medium">
            <Icon name="profile" size={28} className="mx-auto mb-3 text-[#bb162b] animate-spin" />
            Loading your profile data...
          </div>
        </div>
      </Shell>
    );
  }

  if (isAdmin && !adminWorkspace) return null;

  const Shell = adminWorkspace || standalone ? Fragment : KQAppShell;
  return (
    <Shell>
      <div className="app-page max-w-5xl">
        {/* Profile Header */}
        <div className="card profile-hero overflow-hidden mb-8">
          <div className="h-28 bg-gradient-to-r from-[#071626] via-[#0e2740] to-[#1e3a5f] relative">
            <div className="absolute inset-0 opacity-15 pointer-events-none">
              <svg className="w-full h-full" viewBox="0 0 500 150" fill="none">
                <path d="M10 120 C150 40 350 140 490 20" stroke="#fff" strokeWidth="1.5" strokeDasharray="6 6" />
              </svg>
            </div>
          </div>
          <div className="px-6 sm:px-8 pb-6 pt-0 flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4 -mt-10 relative z-10">
            <div className="flex flex-col sm:flex-row items-center sm:items-end gap-4">
              <div className="relative group shrink-0">
                <div className="border-4 border-white rounded-full shadow-md bg-white overflow-hidden">
                  <Avatar name={form.fullName || session?.user?.email} src={avatarSrc || session?.user?.image} userId={session?.user?.id} size="xl" />
                </div>
                <label
                  htmlFor="profile-avatar-upload"
                  className="absolute bottom-0 right-0 p-2 bg-[#c8102e] hover:bg-[#a00d24] text-white rounded-full shadow-md cursor-pointer transition transform hover:scale-105"
                  title="Upload profile picture"
                >
                  <Icon name="profile" size={13} />
                </label>
                <input
                  id="profile-avatar-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={handlePhotoUpload}
                  className="hidden"
                />
              </div>

              <div className="min-w-0 text-center sm:text-left">
                <h1 className="break-words text-2xl font-extrabold text-slate-900 tracking-tight">
                  {form.fullName || "Your Profile"}
                </h1>
                <p className="profile-subtitle mt-0.5 break-words text-xs text-slate-500">
                  {isAdmin ? "Executive Administration" : form.department || "Kenya Airways Stakeholder"} · {session?.user?.email} · {isAdmin ? "Executive Administrator" : "Verified Member"}
                </p>

                {/* Profile Photo Quick Controls */}
                <div className="flex items-center gap-2 mt-2.5 flex-wrap justify-center sm:justify-start">
                  <label
                    htmlFor="profile-avatar-upload"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer transition shadow-2xs"
                  >
                    <Icon name="profile" size={12} />
                    <span>Upload Photo</span>
                  </label>

                  <button
                    type="button"
                    onClick={handleUseGooglePhoto}
                    disabled={!session?.user?.image}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer transition shadow-2xs disabled:cursor-not-allowed disabled:opacity-50"
                    title="Import or sync photo from Google account"
                  >
                    <GoogleIcon size={14} />
                    <span>{session?.user?.image ? "Use Google Photo" : "Google Photo"}</span>
                  </button>

                  {avatarSrc && (
                    <button
                      type="button"
                      onClick={handleRemovePhoto}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:text-red-800 font-medium cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">
                <Icon name="shield" size={13} />
                {isAdmin ? "Executive Access" : "Verified Member"}
              </span>
            </div>
          </div>
        </div>

        {/* Form Grid */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {message && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center gap-2">
              <Icon name="check" size={16} />
              <span className="font-medium">{message}</span>
            </div>
          )}

          {error && (
            <div className="p-3.5 bg-red-50 border border-red-200 text-red-800 text-xs rounded-xl flex items-center gap-2">
              <Icon name="close" size={16} />
              <span className="font-medium">{error}</span>
            </div>
          )}

          {/* Section 1: Core Details */}
          <section className="card p-6 sm:p-8 space-y-5">
            <h2 className="text-base font-bold text-slate-900 pb-3 border-b border-slate-100 flex items-center gap-2">
              <Icon name="profile" size={16} className="text-[#c8102e]" />
              {isAdmin ? "Executive Profile" : "Personal & Department Information"}
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Full Name
                </label>
                <input
                  name="fullName"
                  value={form.fullName}
                  onChange={handleChange}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  {isAdmin ? "Office / Unit" : "Aviation Department / Unit"}
                </label>
                <input
                  name="department"
                  placeholder={isAdmin ? "e.g. Office of the Administrator" : "e.g. Flight Operations, In-flight, Ground Ops, Cargo"}
                  value={form.department}
                  onChange={handleChange}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Bio / Overview
                </label>
                <textarea
                  name="bio"
                  placeholder="Brief summary of your background, experience at Kenya Airways or Pride Centre..."
                  value={form.bio}
                  onChange={handleChange}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                  rows={3}
                />
              </div>
            </div>
          </section>

          {isAdmin && (
            <section className="card p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
                <div>
                  <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <Icon name="shield" size={16} className="text-[#c8102e]" />
                    Executive account
                  </h2>
                  <p className="text-sm text-slate-500 mt-2 max-w-xl">
                    Your account is set up for platform oversight. It is not listed in member matching and has no mentor or mentee availability.
                  </p>
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:min-w-64 sm:grid-cols-2">
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                    <span className="block text-slate-500">Access level</span>
                    <strong className="block text-slate-900 mt-1">Platform administrator</strong>
                  </div>
                  <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3">
                    <span className="block text-emerald-700">Account status</span>
                    <strong className="block text-emerald-900 mt-1">Active · Verified</strong>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 sm:col-span-2">
                    <span className="block text-slate-500">Account reference</span>
                    <strong className="block text-slate-900 mt-1 break-all">{session?.user?.id}</strong>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Section 2: Mentorship Settings */}
          {!isAdmin && <section className="card p-6 sm:p-8 space-y-5">
            <h2 className="text-base font-bold text-slate-900 pb-3 border-b border-slate-100 flex items-center gap-2">
              <Icon name="sparkles" size={16} className="text-[#c59b27]" />
              Mentorship Participation &amp; Career Trajectory
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Mentorship Role
                </label>
                <select
                  name="mentorshipRole"
                  value={form.mentorshipRole}
                  onChange={handleChange}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Available Days
                </label>
                <div className="flex flex-wrap gap-2">
                  {AVAILABILITY_DAYS.map(({ value, label }) => {
                    const selected = availabilityDraft.days.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleAvailabilityDay(value)}
                        className={`min-w-11 rounded-lg border px-3 py-2 text-sm font-semibold transition ${selected ? "border-[#c8102e] bg-rose-50 text-[#a30d25]" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Time Window
                </label>
                <label className="mb-2 flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={availabilityDraft.fullDay}
                    onChange={(event) => updateAvailabilityDraft({ ...availabilityDraft, fullDay: event.target.checked })}
                    className="accent-[#c8102e]"
                  />
                  Available for the full day
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    aria-label="Availability start time"
                    type="time"
                    value={availabilityDraft.fullDay ? "" : availabilityDraft.startTime}
                    disabled={availabilityDraft.fullDay}
                    onChange={(event) => updateAvailabilityDraft({ ...availabilityDraft, startTime: event.target.value })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm outline-none transition focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] disabled:bg-slate-100"
                  />
                  <input
                    aria-label="Availability end time"
                    type="time"
                    value={availabilityDraft.fullDay ? "" : availabilityDraft.endTime}
                    disabled={availabilityDraft.fullDay}
                    onChange={(event) => updateAvailabilityDraft({ ...availabilityDraft, endTime: event.target.value })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm outline-none transition focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] disabled:bg-slate-100"
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-500">Choose a start and end time, or mark the whole day available.</p>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Meeting Frequency
                </label>
                <select
                  value={availabilityDraft.cadence}
                  onChange={(event) => updateAvailabilityDraft({ ...availabilityDraft, cadence: event.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm outline-none transition focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e]"
                >
                  <option value="">Not specified</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="BIWEEKLY">Every two weeks</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="OCCASIONAL">Occasionally</option>
                  <option value="FLEXIBLE">Flexible frequency</option>
                </select>
                {["WEEKLY", "BIWEEKLY", "MONTHLY"].includes(availabilityDraft.cadence) && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="block text-xs font-semibold text-slate-600">
                      Measure availability in
                      <select
                        value={availabilityDraft.frequencyUnit}
                        onChange={(event) => updateAvailabilityDraft({ ...availabilityDraft, frequencyUnit: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e]"
                      >
                        <option value="MEETINGS">Meetings</option>
                        <option value="HOURS">Hours</option>
                      </select>
                    </label>
                    <label className="block text-xs font-semibold text-slate-600">
                      {availabilityDraft.frequencyUnit === "HOURS" ? "Hours per period" : "Meetings per period"}
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={availabilityDraft.sessions}
                        onChange={(event) => updateAvailabilityDraft({ ...availabilityDraft, sessions: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e]"
                      />
                    </label>
                  </div>
                )}
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  These selections are converted into day overlap, time-window overlap, and frequency-fit signals for matching.
                </p>
                {form.availability.trim() && (
                  <p className="mt-1.5 text-xs font-medium text-slate-700" aria-live="polite">
                    Matching reads this as: {interpretedAvailability.length ? interpretedAvailability.join(" · ") : "availability details not recognized"}
                  </p>
                )}
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Career Goals &amp; Objectives
                </label>
                <textarea
                  name="careerGoals"
                  placeholder="What professional milestones are you working towards? (Informs stakeholder matching)"
                  value={form.careerGoals}
                  onChange={handleChange}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                  rows={2}
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Specific Mentorship Needs
                </label>
                <textarea
                  name="mentorshipNeeds"
                  placeholder="What areas or skills do you hope to receive guidance on?"
                  value={form.mentorshipNeeds}
                  onChange={handleChange}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm outline-none focus:border-[#c8102e] focus:ring-1 focus:ring-[#c8102e] transition"
                  rows={2}
                />
              </div>
            </div>
          </section>}

          {/* Section 3: Skills & Taxonomy */}
          {!isAdmin && <section className="card p-6 sm:p-8 space-y-5">
            <h2 className="text-base font-bold text-slate-900 pb-3 border-b border-slate-100 flex items-center gap-2">
              <Icon name="academic" size={16} className="text-emerald-700" />
              Skills &amp; Interests (Profile Competencies)
            </h2>

            <div className="space-y-6">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Technical &amp; Operational Skills ({form.skillIds.length} selected)
                </label>
                <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto p-3 border border-slate-200 rounded-xl bg-slate-50">
                  {(meta.skills || []).map((skill) => {
                    const isSelected = form.skillIds.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => toggleId("skillIds", skill.id)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition border flex items-center gap-1.5 ${
                          isSelected
                            ? "bg-[#c8102e] text-white border-[#c8102e] shadow-xs"
                            : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"
                        }`}
                      >
                        {isSelected && <Icon name="check" size={12} />}
                        {skill.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {[
                  { key: "seekingTopicIds", title: "Topics I want help with", help: "Choose skills where you would value coaching or guidance." },
                  { key: "offeringTopicIds", title: "Topics I can mentor on", help: "Choose skills where you can coach or share experience." },
                ].map(({ key, title, help }) => (
                  <div key={key}>
                    <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">{title}</label>
                    <p className="text-xs text-slate-500 mb-2">{help}</p>
                    <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-3 border border-slate-200 rounded-xl bg-slate-50">
                      {(meta.skills || []).map((skill) => {
                        const selected = form[key].includes(skill.id);
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => toggleId(key, skill.id)}
                            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition border ${selected ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"}`}
                          >
                            {selected && <Icon name="check" size={12} className="inline mr-1" />}
                            {skill.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Aviation &amp; Professional Interests ({form.interestIds.length} selected)
                </label>
                <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto p-3 border border-slate-200 rounded-xl bg-slate-50">
                  {(meta.interests || []).map((interest) => {
                    const isSelected = form.interestIds.includes(interest.id);
                    return (
                      <button
                        key={interest.id}
                        type="button"
                        onClick={() => toggleId("interestIds", interest.id)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition border flex items-center gap-1.5 ${
                          isSelected
                            ? "bg-[#0e2740] text-white border-[#0e2740] shadow-xs"
                            : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"
                        }`}
                      >
                        {isSelected && <Icon name="check" size={12} />}
                        {interest.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-2">
                <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.isPublic}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, isPublic: e.target.checked }))
                    }
                    className="accent-[#c8102e] rounded"
                  />
                  <span>Make my profile publicly discoverable in the Kenya Airways Stakeholder Directory</span>
                </label>
              </div>
            </div>
          </section>}

          {/* Save Button */}
          <div className="flex justify-end pb-8">
            <Button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 text-sm font-semibold shadow-sm"
              icon="arrow"
            >
              {saving ? "Saving..." : "Save Profile"}
            </Button>
          </div>
        </form>
        <div className="mb-8">
          <TwoFactorSettings />
        </div>
        {!isAdmin && (
          <section className="card mb-8 border-red-200 p-6 sm:p-8">
            <h2 className="text-base font-bold text-red-900">Delete account</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
              This permanently removes your sign-in access and anonymizes your profile. Personal details in authored posts and sent messages are removed where possible; records needed to preserve other members&apos; activity are retained without your profile identity.
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={deletingAccount}
              onClick={handleDeleteAccount}
              className="mt-4 border-red-300 text-red-800 hover:bg-red-50"
            >
              {deletingAccount ? "Deleting account..." : "Delete my account"}
            </Button>
          </section>
        )}
      </div>
    </Shell>
  );
}
