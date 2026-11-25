# PrideConnect remediation handover

**Review date:** 24 November 2026
**Scope:** Findings named in the supplied remediation brief and code-level checks of the current checkout.

## Scope and evidence limits

The supplied text describes an independent QA report but does not include a separate report file or finding IDs. This handover uses the findings and severity labels included in that text. It records only evidence obtained in this checkout. No production database, email recipient, Blob object, or member account was modified during this review.

## Remediation register

| Finding | Severity in brief | Source area | Action in this checkout | Verification | Status |
|---|---|---|---|---|---|
| Registration email recovery | Medium | Registration and verification routes; login/register pages | Added rate-limited resend endpoint; replaces old tokens transactionally, sends a new 24-hour token, removes an unsent token after delivery failure, and gives account-neutral responses. Registration page distinguishes delivery failure and points members to resend. | Resend route tests cover successful and unknown-account responses; full tests pass. Real SMTP delivery not tested. | Code addressed; delivery unverified |
| Email verification token replay | Included with registration | `src/app/api/auth/verify/route.js` | Consumes an unexpired token and marks the account verified in one database transaction. Concurrent replays lose the conditional token deletion and cannot verify twice. | Prisma schema validation and build compilation attempt; no dedicated PostgreSQL concurrency test. | Code addressed; database concurrency test outstanding |
| Message pagination | Medium | Conversation messages API and Messages page | Initial fetch returns the newest 100 messages; `before` cursor fetches older messages using `(createdAt, id)` ordering; UI merges by ID and preserves scroll position while loading older messages. Authorization remains conversation-scoped. | Added cursor and 101-message boundary tests; full tests pass. | Code addressed; database-backed test outstanding |
| RSVP to past events | Low | RSVP API and Events page | API rejects a past/started event with HTTP 410; interface disables RSVP for past events while allowing a member to cancel an existing RSVP. Server compares the stored instant to current time. | Added direct API tests for past and future events; full tests pass. | Code addressed |
| Event banner abuse controls | Medium | Event banner API | Retains the 4 MB cap and JPEG/PNG/WebP signature checks; adds an authenticated per-member limit of 8 uploads/hour. Existing Vercel Blob OIDC and token paths are retained. | Lint and full tests pass; no live Blob upload performed. | Partially addressed |
| Banner orphan cleanup and storage quota | Medium | Blob lifecycle | No safe cleanup was added: the current model does not store an upload owner or lifecycle state, and published event management has no corresponding delete/replace lifecycle to prove ownership. | Not tested against Blob. | Outstanding; needs lifecycle design and provider access |
| Recommendation impression inflation | Low | Recommendations API and Prisma schema | Adds a unique nullable deduplication key to `RecommendationEvent`; one member/candidate `SERVED` record is retained per 30-minute window. `skipDuplicates` also makes simultaneous refreshes safe. Other events and later windows still count. | Prisma validation/generation and full test suite pass; the migration passed against a fresh PostgreSQL 16 database in GitHub Actions. Neon has not been changed. | Code addressed; production migration pending |
| Profile API input validation | Medium | Profile API | Validates JSON shape, rejects unknown properties, checks scalar types/lengths, enum values, `isPublic`, and bounded identifier arrays before writes. | Added invalid-length and unexpected-property tests; full tests pass. | Code addressed |
| Database rate-limit migration and CI | Medium | Prisma migration and GitHub Actions | CI starts disposable PostgreSQL 16 and runs the complete migration chain against an empty database before tests/build. | GitHub Actions runs `45386924489` and `45387912936` passed; local Docker is unavailable. | Code and clean-database migration check passed |
| Authentication account enumeration | Medium | Credentials authentication and registration API | Replaces account-specific credential errors (unknown email, wrong password, suspended/unverified/deleted account, Google-only account, and pending flyer review) with one generic failure. New and existing registration addresses now receive the same generic status/body, and the API no longer returns user details. Rate-limit errors remain distinct. | Added/updated security assertions; full suite passes. | Code addressed |
| Trusted proxy IP handling | Medium | Rate limiter | Ignores client-provided `x-forwarded-for`; trusts `x-real-ip` only when running on Vercel. Other environments share a conservative bucket until a trusted ingress integration is deliberately configured. | Added tests proving spoofed forwarding headers do not change the local identity and Vercel real IP is used; full suite passes. | Code addressed for Vercel; other hosting requires ingress configuration |
| Baseline browser security headers | Additional hardening | `next.config.mjs` | Applies `nosniff`, frame denial, strict-origin referrer policy, and disables camera/microphone/geolocation permissions on all routes. | Configuration test passes. Vercel Preview is Ready, but its access gate returned an SSO redirect before the app response headers could be checked. | Code addressed; app response headers need an authenticated Preview check |
| Password reset/session lifecycle | Not assigned in brief | Password-reset routes and auth callbacks | Reviewed current code: reset tokens are random, hashed in storage, time-limited, single-use, rate-limited, and password changes increment session version. | Existing tests plus full suite passed; no real email or browser reset journey. | Code review supports current controls; live journey unverified |
| Google OAuth | Not assigned in brief | Auth callbacks | Existing callback only permits a verified, pre-existing account and checks deleted/suspended/demo/frequent-flyer state. | Credentials and callback URI were not tested. | Configuration-dependent |
| Hosted ML | Not assigned in brief | Hosted prediction helper | Code supports stored ACCEPTANCE/RELEVANCE/NCF artifacts and an optional authenticated hosted endpoint, with local fallback. | No endpoint credential, live model request, or artifact publication was verified during this run. | Configuration/data-dependent |
| Flight Reconnect airline data | Not assigned in brief | Flight Reconnect | Current flow uses member-entered completed-flight details and consent-based exact-match comparisons; code does not verify against airline records. | Source reviewed. | No airline/Asante integration; requires approved data/API access |
| UI/UX browser audit | High in brief | All member/admin pages | Messages and Events gained clearer pagination/closed-registration states. No whole-site visual score or screenshot comparison is claimed. | No authenticated browser automation or assistive-technology session was available. | Partial; manual browser review required |

## Files changed for this remediation

- `src/app/api/auth/resend-verification/route.js` — recovery endpoint.
- `src/app/api/auth/verify/route.js`, `src/app/api/register/route.js`, `src/app/login/page.js`, `src/app/register/page.js` — verification replay handling and user recovery feedback.
- `src/app/api/conversations/[id]/messages/route.js`, `src/app/messages/page.js` — cursor pagination and history loading.
- `src/app/api/events/[id]/rsvp/route.js`, `src/app/events/page.js` — server/client past-event protection.
- `src/app/api/events/banner/route.js` — per-member upload limit; earlier local OIDC compatibility retained.
- `next.config.mjs`, `tests/unit/security-headers.test.js` — baseline security response headers and coverage.
- `src/app/api/profile/route.js` — profile payload validation.
- `src/app/api/recommendations/route.js`, `prisma/schema.prisma`, `prisma/migrations/20261124100000_dedupe_recommendation_impressions/migration.sql` — idempotent served-impression keys.
- `src/lib/auth.js`, `src/lib/rate-limit.js` — generic credential errors and trusted IP resolution.
- `.github/workflows/ci.yml` — PostgreSQL migration smoke test in CI.
- `tests/integration/api-conversation-pagination.test.js`, `tests/integration/api-event-rsvp.test.js`, `tests/integration/api-event-banner-upload.test.js`, `tests/integration/api-resend-verification.test.js`, `tests/integration/api-profile-validation.test.js`, `tests/integration/api-auth-security.test.js`, `tests/integration/api-recommendations.test.js`, `tests/unit/rate-limit.test.js` — regression coverage.

Other modified files in the working tree predate this remediation. They were preserved and are not attributed to this work. In particular, this review did not restore the existing `.env.example` deletion or rewrite unrelated README, auth, or API edits.

## Test and build record

- `npx vitest run --maxWorkers=1 --no-file-parallelism`: **110 tests passed across 22 files**, both locally and in GitHub Actions run [45386924489](https://github.com/K6EDWIN/PrideConnect/actions/runs/45386924489). A local temporary directory was used to work around Windows temporary-file rename failures; without it, Windows failed before tests ran while renaming temporary SSR files.
- `npm run lint`: passed.
- `npx prisma validate`: passed.
- `npx prisma generate`: passed.
- `git diff --check`: passed; Git emitted existing fsmonitor/line-ending warnings.
- `npx next build --webpack`: failed locally with Windows `EPERM` while creating `.next/server/app/api`; the local runtime is Node 20 although the project requires Node 22. The production build passed in GitHub Actions runs [45386924489](https://github.com/K6EDWIN/PrideConnect/actions/runs/45386924489) and [45387912936](https://github.com/K6EDWIN/PrideConnect/actions/runs/45387912936), using the repository's Node 22 setting. Both runs surfaced a non-blocking GitHub Actions Node runtime deprecation notice.
- PostgreSQL migration deployment: the full migration chain passed against a fresh PostgreSQL 16 database in both GitHub Actions runs above. This does **not** apply the new recommendation-event migration to Neon; production database status is unchanged.
- Vercel: commit `6a17de49fe6ee1567e114c08a89bb4159f5f27ec` has a Ready Preview deployment at `https://intelligent-stakeholder-matching-5iedzd6js-edwin-kyles-projects.vercel.app`. The preview is access-gated by Vercel SSO, so authenticated application journeys were not run.
- Vercel environment configuration: the Production environment has `FREQUENT_FLYER_VERIFICATION_KEY` and Blob OIDC store settings (`BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`). No secret values were read or changed. A live Flyer verification or Blob upload was not performed. Production SMTP and ML variable names are configured, but real delivery/model calls were not tested.
- No authenticated browser end-to-end tests, real email delivery, Blob upload, hosted ML call, or production migration was run.

## Database migration to apply

The current database already has the earlier rate-limit migration recorded as applied according to the prior Neon check. This remediation adds only `20261124100000_dedupe_recommendation_impressions`:

```sql
ALTER TABLE "RecommendationEvent"
ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "RecommendationEvent_dedupeKey_key"
ON "RecommendationEvent"("dedupeKey");
```

This is additive: existing rows remain with `NULL` dedupe keys. After applying that SQL to the intended database, mark the migration applied through Prisma using a **direct Neon connection** (not the pooler if it returns P1001):

```powershell
npx prisma migrate resolve --applied 20261124100000_dedupe_recommendation_impressions
npx prisma migrate status
```

Do not run this against production until the owner has confirmed the target branch/database and a current backup. Do not use `prisma db push` to substitute for this migration.

## Manual action plan

| Issue | Why it needs a person/provider | Required action and where | Requirements | Verification | Priority |
|---|---|---|---|---|---|
| Apply the new impression migration to Neon | Production database writes are outside this code-only review. | Confirm the Neon project/branch and backup; run the SQL above in that branch's Neon SQL Editor; then run `migrate resolve` and `migrate status` with the direct connection string. | Neon owner access, direct `DATABASE_URL`, backup/restore point. | The migration appears applied; SQL confirms the nullable column and unique index; `migrate status` reports up to date. | High |
| Confirm migrations from empty PostgreSQL | Complete. | GitHub Actions run `45386924489` ran `prisma migrate deploy` against a disposable PostgreSQL 16 service. | None for this CI check. | Migration step passed on commit `da9c864`. | Complete |
| Production build | Complete in CI; local Windows build is blocked by EPERM and Node 20. | Use the passing GitHub Actions build for this commit; retain its run record. | GitHub Actions access. | Build completed on commit `da9c864`, not an earlier deployment. | Complete |
| Verify real email delivery | Sending externally needs a designated recipient and real SMTP configuration. Production Gmail settings are present, but Preview delivery is unverified. | In Preview, register a dedicated test account, use resend verification, then request/complete password reset. Check the recipient inbox and provider delivery log. | Test email address; Preview SMTP configuration; safe test account and authenticated Preview access. | Both messages arrive with correct Preview host and expire/use as expected. | High |
| Verify Google OAuth | Redirects depend on Google Cloud and Vercel settings. | In Google Cloud Console, confirm the OAuth client’s authorized redirect URI equals `https://<preview-host>/api/auth/callback/google`; add the approved production URI separately. Configure the matching client ID/secret in Vercel Preview/Production. Test only with a pre-registered verified test member. | Google OAuth client; approved redirect origins; Vercel settings access. | Google sign-in completes for the test member and is denied for an unregistered identity. | Medium |
| Verify Blob uploads and storage lifecycle | Blob OIDC store settings are present in Production/Preview, but upload and cleanup require an authenticated test session. | On Vercel Preview, upload a small valid image, attach it to a test event, view it, then remove the test event/banner only through an authorized UI/provider action. Do not revoke old read-write credentials until connected projects have redeployed onto OIDC, as the Vercel screen advises. | Preview Blob store, authenticated test admin/member, cleanup access. | Upload URL loads; invalid/oversize images fail; rate limit works; no production asset is touched. | High |
| Verify hosted ML | Endpoint access/artifacts may be private and configuration is environment-specific. | In Preview settings/ML artifact admin, confirm the selected artifact or endpoint URL and token; send a test recommendation request; inspect provider and model metadata. Never copy secrets into logs. | Preview endpoint/token or published model artifact. | Response source is HOSTED_API/Colab artifact when configured; fallback is clearly reported otherwise. | Medium |
| Run authenticated E2E and role-boundary checks | Requires isolated test data and real sessions. | Use separate Preview member/admin accounts; test registration, verification, sign-in, reset, requests, message history >100, notifications, event RSVP, opportunity browsing, banner upload, and direct admin API access. | Preview DB isolated from production; test inbox; admin test account. | Record screenshots and route/API outcomes; verify a member receives 403 for admin APIs. | High |
| Accessibility/manual UI review | Screen-reader and real-device behaviour cannot be established from unit tests. | Check Classic and Modern at 320/375/390/430/768/1024/1280/1440/1920 px; keyboard-only flows; NVDA/VoiceOver labels, focus, contrast, modals, and touch targets. | Browser and assistive technology. | Save screenshots and a pass/fail checklist for each journey. | Medium |
| Non-Vercel trusted proxy setup | This build intentionally does not trust client-supplied forwarding headers. | If deployed somewhere other than Vercel, integrate that platform's authenticated/stripped client-IP metadata in `src/lib/rate-limit.js` before relying on per-IP throttling. | Hosting provider proxy documentation/configuration. | Forged `x-forwarded-for` cannot change the effective rate-limit identity. | Medium |
| Kenya Airways/Asante records integration | No airline or membership verification API is connected in source. | Obtain written approval, data-sharing terms, and documented API access from Kenya Airways/Asante Rewards; then scope a least-privilege verification integration. Until then describe Frequent Flyer review as manual and Flight Reconnect as member-entered, not airline-verified. | Institutional approval, provider contract/API credentials, privacy review. | Approved sandbox integration and audit trail; no claim of external verification before this passes. | High for real-record claims |

## Remaining risk register and readiness

| Area | Risk | Status / next evidence |
|---|---|---|
| Production deployment | The exact branch commits built in CI and have Ready Preview deployments; `main`/Production was not changed. | Merge through the approved release workflow when production rollout is desired. |
| Database | Full migration chain passes on a clean PostgreSQL 16 database. The new unique-index migration is not applied to Neon. | Neon owner applies it only after backup; then verify migration status. |
| Email | SMTP settings are configured in Production, but delivery remains untested. | Run Preview with a designated recipient and test account. |
| Blob storage | OIDC store settings exist; no live upload was made. Upload quotas do not yet provide storage-byte quotas or orphan cleanup. | Preview upload and lifecycle test; design ownership/cleanup before automated deletion. |
| UI/UX | No whole-site screenshot/viewport evaluation was possible here. | Run the manual visual/accessibility plan above. |
| Hosted ML | Production service variable names are present, but no live endpoint/artifact response was verified. | Confirm Preview model source and response after authenticated access is available. |
| Flight verification | Flight details are self-reported; there is no live airline-record cross-check. | Obtain approved partner integration or keep the limitation explicit in the UI/documentation. |
| Rate limiting | Vercel edge IP is trusted; non-Vercel hosting gets a shared bucket. | Add platform-specific trusted ingress before deploying elsewhere. |

**Assessment:** The code-level fixes above are implemented and the local lint, Prisma validation/generation, and automated tests pass. PrideConnect is **not declared production-ready** by this review: the new migration, exact-commit production build, authenticated Preview journeys, actual email/Blob/ML integrations, accessibility review, and external airline verification remain unverified or require human/provider action.
