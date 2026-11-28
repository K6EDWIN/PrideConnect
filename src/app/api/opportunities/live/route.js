import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

const API_BASE = "https://api-irec-prod.kenya-airways.com/api";
const CAREERS_BASE = "https://careers.kenya-airways.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CAREER_PAGE_SIZE = 100;
const MAX_CAREER_PAGES = 5;

function plainText(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[\t\u00a0 ]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "PrideConnect opportunity feed" },
    signal: AbortSignal.timeout(12_000),
    // The opportunities page refreshes once a minute and exposes a manual
    // refresh action. Keep shared upstream traffic on that same cadence.
    next: { revalidate: 60 },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Kenya Airways Careers did not return listing data");
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Careers response exceeded the size limit");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new Error("Careers response exceeded the size limit");
  return JSON.parse(raw);
}

function namedRecords(value, idField, nameField) {
  const items = Array.isArray(value) ? value : value?.data;
  return new Map((Array.isArray(items) ? items : []).map((item) => [item[idField], item[nameField]]).filter(([id, name]) => id && name));
}

function toOpportunity(job, divisions, locations) {
  const expiresAt = job.expirationDate ? new Date(job.expirationDate) : null;
  if (!job.id || !job.title || job.status !== 1 || !job.description || !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) return null;
  const division = divisions.get(job.division) || "";
  const location = locations.get(job.location) || "";
  const employmentType = typeof job.employmentType === "string" ? job.employmentType : "";
  const sourceUrl = `${CAREERS_BASE}/anonymous/listing/${encodeURIComponent(job.id)}/details?division=${encodeURIComponent(job.division || "")}`;
  return {
    id: `kq-${job.id}`,
    title: String(job.title).slice(0, 180),
    description: plainText(job.description).slice(0, 12000),
    responsibilities: plainText(job.responsibilities),
    skills: plainText(job.skills),
    qualifications: plainText(job.qualifications),
    howToApply: plainText(job.howToApply),
    location,
    companyName: "Kenya Airways",
    numberOfPositions: job.numberOfPositions || null,
    type: /intern|graduate trainee|cadet/i.test(`${job.title} ${employmentType}`) ? "Internship" : "Career Opening",
    sourceUrl,
    expiresAt: expiresAt.toISOString(),
    division: division || null,
    employmentType: employmentType || null,
    postedBy: { profile: { fullName: "Kenya Airways Careers" } },
    liveSource: true,
  };
}

export async function GET(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    // The careers website itself is a JavaScript app. Its public job cards are
    // populated from this JSON service, not embedded in the page HTML.
    const [firstListingPage, divisionData, locationData] = await Promise.all([
      fetchJson(`${API_BASE}/Jobs/JobListing?Status=1&page=1&pageSize=${CAREER_PAGE_SIZE}`),
      fetchJson(`${API_BASE}/ERPData/divisions`),
      fetchJson(`${API_BASE}/ERPData/locations`),
    ]);
    const divisions = namedRecords(divisionData, "divisionID", "divisionName");
    const locations = namedRecords(locationData, "locationId", "locationName");
    const firstJobs = Array.isArray(firstListingPage?.data) ? firstListingPage.data : [];
    const declaredCount = firstListingPage?.totalCount ?? firstListingPage?.totalRecords ?? firstListingPage?.totalItems ?? firstListingPage?.meta?.totalCount;
    const declaredPages = Number(
      firstListingPage?.totalPages
      ?? firstListingPage?.pagination?.totalPages
      ?? firstListingPage?.meta?.totalPages
      ?? (declaredCount != null ? Math.ceil(Number(declaredCount) / CAREER_PAGE_SIZE) : 0),
    );
    const pageCount = Math.min(MAX_CAREER_PAGES, Math.max(1,
      Number.isFinite(declaredPages) && declaredPages > 1
        ? Math.ceil(declaredPages)
        : firstJobs.length >= CAREER_PAGE_SIZE ? MAX_CAREER_PAGES : 1,
    ));
    const laterPages = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) =>
        fetchJson(`${API_BASE}/Jobs/JobListing?Status=1&page=${index + 2}&pageSize=${CAREER_PAGE_SIZE}`),
      ))
      : [];
    const finalPageJobs = Array.isArray(laterPages.at(-1)?.data) ? laterPages.at(-1).data : firstJobs;
    const feedTruncated = (Number.isFinite(declaredPages) && declaredPages > pageCount)
      || (!(Number.isFinite(declaredPages) && declaredPages > 0) && finalPageJobs.length >= CAREER_PAGE_SIZE);
    const jobs = [...new Map(
      [firstJobs, ...laterPages.map((page) => Array.isArray(page?.data) ? page.data : [])]
        .flat()
        .filter((job) => job?.id)
        .map((job) => [job.id, job]),
    ).values()];
    const opportunities = jobs.map((job) => toOpportunity(job, divisions, locations)).filter(Boolean);
    const requestedId = new URL(request.url).searchParams.get("id");
    if (requestedId) {
      const opportunity = opportunities.find((item) => item.id === requestedId);
      return opportunity
        ? NextResponse.json({ opportunity })
        : NextResponse.json({ error: "This Kenya Airways Careers listing is no longer available." }, { status: 404 });
    }
    return NextResponse.json({ opportunities, source: "Kenya Airways Careers", refreshedAt: new Date().toISOString(), pagesFetched: pageCount, feedTruncated });
  } catch (error) {
    console.error("Kenya Airways Careers feed could not be refreshed:", error);
    return NextResponse.json({ error: "Kenya Airways Careers listings are temporarily unavailable. Please try again shortly." }, { status: 502 });
  }
}
