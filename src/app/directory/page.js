"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import KQAppShell from "@/components/KQAppShell";
import { Button, Tag, Avatar } from "@/components/KQBrand";
import { Icon } from "@/components/KQIcons";
import RequestActions from "@/components/RequestActions";
import ReportButton from "@/components/ReportButton";
import { readApiResponse } from "@/lib/read-api-response";

const ROLE_LABELS = {
  ALUMNI: "Pride Centre Alumni",
  STAFF: "Active KQ Staff",
  FORMER_STAFF: "Former KQ Employee",
  FREQUENT_FLYER: "Frequent Flyer",
  ADMIN: "Administrator",
};

const ROLE_OPTIONS = [
  { value: "", label: "All Stakeholder Roles" },
  { value: "STAFF", label: "Active Staff & Flight Crew" },
  { value: "ALUMNI", label: "Pride Centre Alumni" },
  { value: "FORMER_STAFF", label: "Former Employees" },
  { value: "FREQUENT_FLYER", label: "Asante Frequent Flyers" },
];

export default function DirectoryPage() {
  const { status } = useSession();
  const router = useRouter();

  const [meta, setMeta] = useState({ skills: [], interests: [] });
  const [profiles, setProfiles] = useState([]);
  const [profilesTotal, setProfilesTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    role: "",
    skill: "",
    interest: "",
    department: "",
    q: "",
  });

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/meta")
      .then((res) => readApiResponse(res, "Could not load profile filters"))
      .then(setMeta)
      .catch(() => {});
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/directory?departments=true")
      .then(async (res) => {
        const data = await readApiResponse(res, "Could not load departments");
        setDepartments(data.departments || []);
      })
      .catch((err) => setError(err.message));
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams();
      if (filters.role) params.set("role", filters.role);
      if (filters.skill) params.set("skill", filters.skill);
      if (filters.interest) params.set("interest", filters.interest);
      if (filters.department) params.set("department", filters.department);
      if (filters.q) params.set("q", filters.q);
      params.set("page", String(page));

      try {
        setLoading(true);
        setError("");
        const res = await fetch(`/api/directory?${params.toString()}`, { signal: controller.signal });
        const data = await readApiResponse(res, "Could not load directory");
        setProfiles(data.profiles || []);
        setProfilesTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      } catch (err) {
        if (err.name !== "AbortError") setError(err.message || "Could not load directory. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, filters.q ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [status, filters, page, reloadKey]);

  const handleFilterChange = (key, val) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: val }));
  };

  if (status === "loading" || (loading && !profiles.length)) {
    return (
      <KQAppShell>
        <div className="max-w-7xl mx-auto px-6 py-24 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-slate-100 text-[#0e2740] flex items-center justify-center">
            <Icon name="directory" size={24} />
          </div>
          <h2 className="text-xl font-bold text-slate-800">
            Loading Stakeholder Directory...
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Accessing verified Kenya Airways community member records.
          </p>
        </div>
      </KQAppShell>
    );
  }

  return (
    <KQAppShell>
      <div className="app-page space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[#c8102e] mb-1">
              Global Aviation Network
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Stakeholder Directory
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Browse verified Kenya Airways mentors, alumni, active crew, and technical specialists.
            </p>
          </div>
          <Button icon="sparkles" onClick={() => router.push("/recommendations")}>
            View Smart Matches
          </Button>
        </div>

        {/* Search & Filters Toolbar */}
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 items-center">
            {/* Search Input */}
            <div className="lg:col-span-4 relative">
              <Icon
                name="search"
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                aria-label="Search members"
                placeholder="Search by name, department, or keyword..."
                value={filters.q}
                onChange={(e) => handleFilterChange("q", e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm outline-none focus:border-[#c8102e] focus:bg-white transition text-slate-800"
              />
            </div>

            {/* Role Filter */}
            <div className="lg:col-span-2">
              <select
                aria-label="Filter by stakeholder role"
                value={filters.role}
                onChange={(e) => handleFilterChange("role", e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm outline-none focus:border-[#c8102e] text-slate-700"
              >
                {ROLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <select
                aria-label="Filter by department"
                value={filters.department}
                onChange={(e) => handleFilterChange("department", e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm outline-none focus:border-[#c8102e] text-slate-700"
              >
                <option value="">All Departments</option>
                {departments.map((department) => <option key={department} value={department}>{department}</option>)}
              </select>
            </div>

            {/* Skill Filter */}
            <div className="lg:col-span-2">
              <select
                aria-label="Filter by skill"
                value={filters.skill}
                onChange={(e) => handleFilterChange("skill", e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm outline-none focus:border-[#c8102e] text-slate-700"
              >
                <option value="">All Skills</option>
                {(meta.skills || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Interest Filter */}
            <div className="lg:col-span-2">
              <select
                aria-label="Filter by interest area"
                value={filters.interest}
                onChange={(e) => handleFilterChange("interest", e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm outline-none focus:border-[#c8102e] text-slate-700"
              >
                <option value="">All Domains</option>
                {(meta.interests || []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs text-slate-500">
            <span>
              Showing <b>{profiles.length ? (page - 1) * 24 + 1 : 0}–{Math.min(page * 24, profilesTotal)}</b> of <b>{profilesTotal}</b> verified stakeholders
            </span>
            <button
              type="button"
              onClick={() => { setPage(1); setFilters({ role: "", skill: "", interest: "", department: "", q: "" }); }}
              className="text-[#c8102e] font-semibold hover:underline cursor-pointer"
            >
              Reset Filters
            </button>
          </div>
        </div>

        {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><Button size="sm" variant="secondary" onClick={() => setReloadKey((key) => key + 1)}>Try again</Button></div>}
        {loading && profiles.length > 0 && <p role="status" className="text-sm text-slate-500">Updating results…</p>}

        {/* Directory Grid */}
        {!error && profiles.length === 0 ? (
          <div className="card p-12 text-center text-slate-500 space-y-2">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">
              <Icon name="search" size={22} />
            </div>
            <h3 className="font-bold text-slate-800 text-base">No Stakeholders Found</h3>
            <p className="text-sm text-slate-500 max-w-sm mx-auto">
              No profiles matched your filter criteria. Try clearing the search query or domain filters.
            </p>
          </div>
        ) : !error && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {profiles.map((p) => (
              <article key={p.userId} className="card p-6 flex flex-col justify-between space-y-5">
                <div>
                  {/* Card Top: Role Tag */}
                  <div className="flex items-center justify-between pb-3.5 border-b border-slate-100">
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md bg-slate-100 text-slate-700">
                      {ROLE_LABELS[p.role] || p.role}
                    </span>
                    <span className="text-[11px] font-medium text-slate-400">
                      Verified Member
                    </span>
                  </div>

                  {/* Identity */}
                  <div className="flex items-start gap-3.5 mt-3.5">
                    <Avatar name={p.fullName} size="lg" role={p.role} />
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-bold text-slate-900 truncate">
                        {p.fullName}
                      </h3>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {p.department || "Kenya Airways Community Member"}
                      </p>
                      <span className="inline-block mt-1 text-xs font-medium text-[#c8102e]">
                        {p.mentorshipRole === "MENTOR"
                          ? "Available Mentor"
                          : p.mentorshipRole === "MENTEE"
                          ? "Seeking Mentorship"
                          : "Open to Connect"}
                      </span>
                    </div>
                  </div>

                  {/* Bio */}
                  {p.bio && (
                    <p className="text-xs text-slate-600 line-clamp-2 mt-3.5 leading-relaxed">
                      &quot;{p.bio}&quot;
                    </p>
                  )}

                  {/* Skills & Interests Tags */}
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {(p.skills || []).slice(0, 3).map((skill) => (
                      <Tag key={skill}>{skill}</Tag>
                    ))}
                    {(p.interests || []).slice(0, 2).map((interest) => (
                      <Tag key={interest} gold>
                        {interest}
                      </Tag>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="pt-4 border-t border-slate-100">
                  <RequestActions
                    receiverId={p.userId}
                    userId={p.userId}
                    mentorshipRole={p.mentorshipRole}
                  />
                  <ReportButton targetType="USER" targetId={p.userId} />
                </div>
              </article>
            ))}
          </div>
        )}
        {profilesTotal > 24 && (
          <nav aria-label="Stakeholder directory pages" className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-500">Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
            </div>
          </nav>
        )}
      </div>
    </KQAppShell>
  );
}
