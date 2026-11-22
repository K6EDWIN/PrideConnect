# PrideConnect

**Intelligent stakeholder matching for mentorship and professional networking in the Kenya Airways community.**

PrideConnect is a student-built web application that helps members discover potential mentors and professional peers. Members can create profiles, receive explainable recommendations, connect with one another, and share community events and career opportunities. The project was developed as a Strathmore University capstone; it is not an official Kenya Airways service.

## Project at a glance

- **Application:** Next.js 16, React 19, JavaScript
- **Database:** PostgreSQL with Prisma
- **Authentication:** NextAuth credentials, with optional Google sign-in
- **Recommendation methods:** profile-based matching, collaborative filtering, member feedback, and adaptive acceptance signals
- **Model training:** Google Colab notebook for protected live-data training and NCF evaluation
- **Deployment:** designed to run on Vercel with PostgreSQL; optional Python inference service

## Features

### For members

- Build a profile with professional background, skills, interests, mentoring goals, and availability.
- Browse the stakeholder directory and receive ranked mentor and peer suggestions with reasons for each match.
- Send and manage mentorship or connection requests, and message accepted connections.
- Rate whether a recommendation is useful and, after a mentorship, whether it helped.
- Share completed flights through Flight Reconnect. A match is shown only when both members consent.
- Post and RSVP to community events, including optional event banners and member email announcements.
- Post career opportunities and report profiles or content for review.

### For administrators

- Verify and manage accounts, review community reports, and inspect audit activity.
- View recommender diagnostics, feedback, ranking metrics, and recommendation exposure summaries.

Features are subject to authentication, verification, consent, and role checks in the application.

## How recommendations work

The system uses different signals for different questions; an acceptance estimate is not the same thing as a relevance judgment.

| Method | What it uses | Role in the application |
|---|---|---|
| Content-based matching | Shared skills, interests, mentoring goals, profile text, and compatible availability | Provides recommendations when interaction history is limited. |
| Collaborative filtering | Patterns in accepted mentorship and connection requests | Adds network context when members have enough shared history. |
| Acceptance model | Outcomes of resolved requests and feature snapshots recorded when requests were sent | Estimates the chance that a similar request will be accepted. |
| Relevance model | Members’ explicit useful / not useful match ratings | Learns a separate signal for match relevance when enough ratings exist. |
| Neural Collaborative Filtering (NCF) | Eligible historical interactions and pseudonymous member IDs, trained in Colab | Quality-gated; contributes up to 10% when a pair estimate is available. |

The application records recommendation impressions and member actions to support later evaluation. It does not treat synthetic demo data or shared-skills proxy labels as evidence of real-world recommendation quality. See [the model report](docs/ML_MODEL.md) for formulas, thresholds, and current limitations.

## Evaluation and limitations

The Admin Console reports ranking diagnostics, chronological holdouts, member-judged results when enough feedback exists, and exposure summaries. Some benchmark metrics use a designed proxy based on profile overlap or existing connections; these are not independent member judgments. Holdout results are internal checks, not proof of usefulness, fairness, or improved outcomes.

The project still needs more real, consented usage data and repeated time-based comparisons before stronger claims can be made. A quality-gated NCF artifact contributes up to 10% of the ranking score when it can predict a member pair; it falls back to profile/relevance ranking when it cannot. This limited influence is not evidence that NCF consistently outperforms simpler baselines. The older notebook at `ml/train_recommender.ipynb` uses fabricated data and is a separate research experiment; its results are not used by the live site.

## Run locally

### Requirements

- Node.js 22 or newer
- npm
- PostgreSQL, either through the included Docker Compose setup or another PostgreSQL provider

### 1. Install packages

```bash
npm install
```

### 2. Configure the environment

Copy `.env.example` to `.env`, then set at least:

```dotenv
DATABASE_URL="postgresql://..."
NEXTAUTH_SECRET="<a-long-random-secret>"
APP_URL="http://localhost:3000"
```

To use the local PostgreSQL container shown in `.env.example`:

```bash
docker compose up -d postgres
```

Optional integrations:

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Verification, invitation, and event announcement emails; use a Google App Password. |
| `BLOB_READ_WRITE_TOKEN` | Optional Vercel Blob storage for event banner uploads. |
| `FREQUENT_FLYER_VERIFICATION_KEY` | Required to collect Asante membership evidence; use a private, stable, base64-encoded 32-byte key. Never rotate it without a planned re-encryption of pending review records. |
| `ML_SERVICE_URL`, `ML_SERVICE_TOKEN` | Optional hosted Python inference service. |
| `ML_COLAB_SYNC_TOKEN`, `ML_COLAB_USER_SALT` | Protected Colab data export and artifact publishing. Keep the pseudonym salt stable and private. |

Never commit `.env` or real secrets. For production, configure secrets in the hosting provider and set `APP_URL` to the public HTTPS site URL. Event banners require a public Vercel Blob store and its read/write token; events can still be posted without a banner.

Frequent Flyer registration encrypts Asante Rewards and recent-flight details for restricted administrator review. Evidence is opened on demand, access is audited, and its encrypted payload is cleared when the review is completed; the review outcome and note remain. Apply the `20261123100000_minimize_frequent_flyer_evidence` migration before deploying this change. Generate `FREQUENT_FLYER_VERIFICATION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and set the same private value locally and in the hosting environment. No airline verification service is connected, so an administrator must compare submissions with records they are authorized to access. Password reset uses the configured Gmail email service and one-time links that expire after 30 minutes.

### 3. Create the local database schema

For a new local development database:

```bash
npm run db:push
```

For a local demonstration dataset, optionally run:

```bash
npm run seed
```

The seed data is fabricated and marked as demo data. Use it only with a local or dedicated demo database; do not seed a production database. For a live database, review and apply the required SQL migrations to the intended database before deploying. For example, the event banner migration is in [`prisma/migrations/20261115150000_add_event_banner/migration.sql`](prisma/migrations/20261115150000_add_event_banner/migration.sql).

To add clearly marked aviation sample events for local page testing, run `npm run seed:aviation-content` after the standard seed. It creates three sample events with local SVG banners and does not send announcement emails. It does not invent job listings; import a current opening from the official Kenya Airways Careers portal through the Opportunities page. This command refuses to run against production or a non-local database and removes the old local-only `TEST LISTING` fixture rows when rerun.

### 4. Start the application

```bash
npm run dev
```

Open <http://localhost:3000>.

## Common commands

```bash
npm run lint       # Check the application code
npm test           # Run unit and integration tests
npm run build      # Generate Prisma Client and build the application
npm run start      # Serve a completed production build
```

## Train and publish models

The live-data workflow is in [`ml/colab_live_recommender.ipynb`](ml/colab_live_recommender.ipynb). It exports eligible interaction outcomes as numeric features, labels, timestamps, and keyed pseudonyms. It does not export names, email addresses, profile text, or raw account IDs. The notebook trains and evaluates model artifacts, saves outputs to Google Drive, and can publish artifacts to the authenticated app endpoint.

Configure `ML_COLAB_SYNC_TOKEN` on the application and as a Colab Secret named `ML_COLAB_SYNC_TOKEN`. Set `PRIDECONNECT_APP_URL` in Colab to the deployed site URL. Keep `ML_COLAB_USER_SALT` stable on the app server; do not put it in the notebook or share it. Apply relevant database changes before using the live-data workflow.

Colab is used for training and publishing, not as a continuously running inference server. Once published, artifacts are stored in PostgreSQL. Quality-gated NCF acceptance predictions can supply up to 10% of the ranking score when a member-pair prediction is available. Full instructions and methodological details are in [`ml/README.md`](ml/README.md) and [`docs/ML_MODEL.md`](docs/ML_MODEL.md).

## Architecture

```text
Browser (Next.js / React)
          │ authenticated requests
          ▼
Next.js pages and API routes ── Prisma ── PostgreSQL
          │                                  ▲
          └── optional Python service        │ published model artifacts

Google Colab notebook ── protected numeric training export
                      └── evaluated model artifacts ──► application API
```

Useful locations:

| Location | Contents |
|---|---|
| `src/app/` | Application pages and API routes |
| `src/components/` | Shared interface components |
| `src/lib/` | Authentication, database access, and recommendation logic |
| `prisma/schema.prisma` | Database models and enums |
| `prisma/migrations/` | Reviewed database migration SQL |
| `ml/colab_live_recommender.ipynb` | Live-data training and evaluation workflow |
| `ml/huggingface/` | Optional Python inference API |
| `docs/` | Project, model, data, and evaluation documentation |

## Privacy and safety

Directory recommendations are restricted to verified, public profiles; suspended, deleted, and demo accounts are not eligible. Demo and deleted accounts are excluded from model-training exports. Flight Reconnect exposes a match only with consent from both members. Reports are restricted to administrator review. The Colab training export and optional Python service use numeric features and pseudonymous IDs, not member names or raw profile text.

This academic prototype is not approved for sensitive operational or passenger data. Review the data model, retention expectations, consent flows, and hosting configuration before any real-world rollout. See [the data guide](docs/DATA.md) and [evaluation protocol](docs/EVALUATION_PROTOCOL.md).

## Documentation

- [Model methods and results](docs/ML_MODEL.md)
- [Google Colab instructions](ml/README.md)
- [Data and demo seed guide](docs/DATA.md)
- [Evaluation protocol](docs/EVALUATION_PROTOCOL.md)
- [AI development disclosure](docs/AI_USAGE.md)
- [Project roadmap](docs/ROADMAP.md)

## Academic information

- **Research title:** Intelligent Stakeholder Matching for Mentorship and Professional Networking Using Hybrid Recommendation Techniques: A Case of Kenya Airways
- **Author:** Kamau Edwin Kamau (Admission No. 152803)
- **Course:** Informatics and Computer Sciences, ICS 4 Group B
- **Institution:** Strathmore University, Nairobi, Kenya
- **Supervisor:** Madam Julliet Kirui

## License and affiliation

This is an academic capstone prototype and is not an official Kenya Airways product. Kenya Airways names and marks belong to their respective owners. The project is distributed under the MIT License; see [`LICENSE`](LICENSE).
