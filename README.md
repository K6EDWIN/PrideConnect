# PrideConnect

**An intelligent stakeholder-matching platform for mentorship and professional networking in the Kenya Airways community.**

PrideConnect helps community members find potential mentors and professional peers using profile information, interaction history, and member feedback. Members can manage profiles, explore recommendations, connect, message, share events, and find career opportunities.

This is an academic capstone prototype developed at Strathmore University. It is an independent project and is not an official Kenya Airways service.

## Contents

- [What the application does](#what-the-application-does)
- [How recommendations work](#how-recommendations-work)
- [Evaluation and limitations](#evaluation-and-limitations)
- [Technology](#technology)
- [Run locally](#run-locally)
- [Database setup](#database-setup)
- [Train and publish models](#train-and-publish-models)
- [Project structure](#project-structure)
- [Privacy and responsible use](#privacy-and-responsible-use)
- [Documentation](#documentation)
- [Authorship](#authorship)
- [License](#license)

## What the application does

### Member features

- Create a professional profile with skills, interests, career goals, mentorship needs, and availability.
- Browse the stakeholder directory and receive ranked mentor and peer suggestions with explanations.
- Send and manage mentorship and connection requests, message accepted connections, and give feedback on matches.
- Share a completed flight through Flight Reconnect. A flight match is visible only when both members have opted in.
- Browse and post community events, RSVP, and optionally include a banner.
- Browse career opportunities, including current listings from the Kenya Airways Careers site, and report profiles or content for review.
- Register as a Frequent Flyer and submit membership details for administrator review.

### Administrator features

- Review and manage member accounts, Frequent Flyer verification requests, and community reports.
- Inspect audit activity, recommendation diagnostics, feedback, evaluation results, and recommendation exposure.
- Publish and manage events and community opportunities.

Features depend on account verification, permissions, and member consent where applicable.

## How recommendations work

PrideConnect separates **match relevance** from **acceptance likelihood**. Relevance estimates how suitable two profiles are for mentorship or networking; acceptance estimates whether a recipient may accept a request. They are different predictions and are presented as separate signals.

| Method | Evidence used | How it is used |
|---|---|---|
| Content-based matching | Skills, interests, mentorship topics, role compatibility, profile information, and availability | Supports recommendations, including for members with little interaction history. |
| Collaborative filtering | Patterns in accepted mentorship and connection activity | Adds evidence from the community’s interaction history where enough data exists. |
| Learned relevance | Explicit member ratings of recommendation relevance | Adds a member-judged relevance signal when there is enough feedback. |
| Acceptance model | Outcomes of resolved requests and numeric feature snapshots | Estimates acceptance likelihood; this is displayed separately from relevance. |
| Neural Collaborative Filtering (NCF) | Eligible historical request outcomes and pseudonymous member identifiers | A quality-gated estimate can contribute up to 10% of the ranking score when an eligible member-pair prediction is available. Otherwise, ranking falls back to the other signals. |

The app records recommendation positions and events such as views, dismissals, contacts, and ratings to support later evaluation. The text-matching signal is computed locally from profile terms; it is not a pretrained language model. For implementation details, thresholds, and current limitations, see [the model report](docs/ML_MODEL.md).

## Evaluation and limitations

The administrator evaluation includes proxy benchmarks, chronological checks, member-judged ranking results when sufficient ratings exist, and exposure summaries. Shared skills or existing connections may be used as proxy labels; those results are not independent member judgments. Member-judged results only describe recommendations that members rated, so they may not represent every recommendation shown.

The available data is not yet enough to claim that the recommender improves real mentorship outcomes or is fair across the community. NCF is quality-gated and has limited influence; its presence does not mean it consistently outperforms simpler methods. Collect more consented feedback and compare methods across repeated time-based holdouts before making stronger performance claims.

The older `ml/train_recommender.ipynb` notebook is a separate experiment using fabricated data. It is not used by the live site. The live-data workflow is `ml/colab_live_recommender.ipynb`.

## Technology

- **Web application:** Next.js 16, React 19, JavaScript
- **Database:** PostgreSQL, accessed through Prisma
- **Authentication:** NextAuth credentials, with optional Google sign-in
- **Model training:** Google Colab notebook for eligible live-data training and evaluation
- **Hosting:** Vercel with PostgreSQL; an optional Python inference service is also supported
- **File storage:** Optional Vercel Blob for event banners

## Run locally

### Requirements

- Node.js 22 or later
- npm
- PostgreSQL, locally or through a PostgreSQL provider

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

The repository does not include an environment template. Create a `.env` file in the project root and set the values required for your setup. At minimum, local development needs:

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/DATABASE_NAME"
NEXTAUTH_SECRET="replace-with-a-long-random-secret"
NEXTAUTH_URL="http://localhost:3000"
APP_URL="http://localhost:3000"
```

If you use the included PostgreSQL container, start it with:

```bash
docker compose up -d postgres
```

Set optional values only for the integrations you enable:

| Variable | Used for |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Verification, invitation, password-reset, and event announcement email. Use a Google App Password. |
| `BLOB_READ_WRITE_TOKEN` | Event banner uploads to Vercel Blob. Events can be posted without a banner. |
| `FREQUENT_FLYER_VERIFICATION_KEY` | Encrypting Frequent Flyer membership and recent-flight evidence. Use a private, stable, base64-encoded 32-byte key. |
| `RATE_LIMIT_SECRET` | Optional dedicated secret for hashing rate-limit identifiers. If omitted, the app uses `NEXTAUTH_SECRET`. |
| `TWO_FACTOR_ENCRYPTION_KEY` | Required to enroll authenticator-app 2FA. Generate a private, stable, base64-encoded 32-byte key; the server uses it for AES-256-GCM encryption of TOTP secrets. |
| `TWO_FACTOR_HASH_KEY` | Optional dedicated key for hashing one-time and recovery codes. If omitted, the app uses `NEXTAUTH_SECRET`. |
| `ML_SERVICE_URL`, `ML_SERVICE_TOKEN` | Optional hosted Python inference service. |
| `ML_COLAB_SYNC_TOKEN`, `ML_COLAB_USER_SALT` | Protected Colab data export and model publishing. Keep both private; keep the pseudonym salt stable. |

Generate secrets with a secure random generator. For example, generate the Frequent Flyer key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use the same command to generate `TWO_FACTOR_ENCRYPTION_KEY`. Configure it in local `.env` and the deployment environment before enabling authenticator-based 2FA. Email-based 2FA uses the configured Gmail delivery integration. Apply the new `prisma/migrations/20261128100000_add_two_factor_auth/migration.sql` migration to the production database before deploying this version; it adds the 2FA configuration, challenge, and one-use recovery-code storage. Existing accounts remain without 2FA until each user enables it in Profile → Account security.

Never commit `.env` or real credentials. Configure production values in the hosting provider, and set `APP_URL` and `NEXTAUTH_URL` to the public HTTPS site URL.

Frequent Flyer details are encrypted for restricted administrator review. The app does not connect to an airline verification service; an administrator must compare submitted details with records they are authorized to access. After review, the encrypted evidence is cleared while the review outcome and note are retained. Keep the encryption key stable while pending records need review. Password-reset links are one-time links that expire after 30 minutes.

### 3. Prepare the database

For a new local development database, generate Prisma Client and apply the schema:

```bash
npx prisma generate
npm run db:push
```

For an existing database, apply the reviewed migration files to the intended database before deploying. Do not use `prisma db push` or development migrations against production without reviewing the effect first. Migration history and database schema must agree; if SQL was applied manually, reconcile Prisma’s migration history before running deployment migrations.

For a local demonstration dataset, optionally run:

```bash
npm run seed
npm run seed:aviation-content
```

Seed records are fabricated demo data. Use them only in a local or dedicated demo database, never in production. The aviation-content command creates three clearly marked sample events with local SVG banners; it does not send event announcement emails or create sample job listings. Import current Kenya Airways openings through the Opportunities page.

### 4. Start the development server

```bash
npm run dev
```

Open <http://localhost:3000>.

## Common commands

```bash
npm run lint       # Check application code
npm test           # Run unit and integration tests
npm run build      # Generate Prisma Client and build the application
npm run start      # Serve a completed production build
```

## Train and publish models

The live-data training workflow is [`ml/colab_live_recommender.ipynb`](ml/colab_live_recommender.ipynb). It exports eligible outcomes as numeric features, labels, timestamps, and keyed pseudonyms. It does not export names, email addresses, profile text, request messages, availability text, or raw account IDs. Demo users and their outcomes are excluded.

Configure `ML_COLAB_SYNC_TOKEN` in the application environment and as a Colab Secret with the same name. In Colab, set `PRIDECONNECT_APP_URL` to the deployed site URL. Keep `ML_COLAB_USER_SALT` private and stable on the application server; do not put it in the notebook or share it. Ensure the required database schema is applied before using the export or publishing workflow.

Colab trains and publishes artifacts; it is not a continuously running inference server. Published artifacts are stored in PostgreSQL and can be used by the application after the notebook disconnects. NCF artifacts are activated only when the configured quality and coverage checks pass. See [`ml/README.md`](ml/README.md) and [`docs/ML_MODEL.md`](docs/ML_MODEL.md) for setup and methodology.

## Project structure

| Path | Purpose |
|---|---|
| `src/app/` | Application pages and API routes. |
| `src/components/` | Shared interface components. |
| `src/lib/` | Authentication, database access, and recommendation logic. |
| `prisma/schema.prisma` | Database models and enums. |
| `prisma/migrations/` | Versioned database migration SQL. |
| `ml/colab_live_recommender.ipynb` | Live-data model training and evaluation. |
| `ml/huggingface/` | Optional Python inference service. |
| `docs/` | Project, model, data, and evaluation documentation. |

## Privacy and responsible use

Recommendations are limited to eligible verified, public profiles. Suspended, deleted, and demo accounts are excluded from live training exports. Flight Reconnect requires consent from both members before showing a match. Frequent Flyer evidence is encrypted and restricted to administrator review. Training exports and the optional Python service use numeric features and pseudonymous identifiers rather than names or raw profile text.

PrideConnect is an academic prototype and is not approved for sensitive operational, employee, or passenger data. Any real-world use would require organizational approval, security review, a clear retention policy, and appropriate member consent. Read the [data guide](docs/DATA.md) and [evaluation protocol](docs/EVALUATION_PROTOCOL.md).

## Documentation

- [Model methods and results](docs/ML_MODEL.md)
- [Google Colab setup](ml/README.md)
- [Data and demo seed guide](docs/DATA.md)
- [Evaluation protocol](docs/EVALUATION_PROTOCOL.md)
- [AI development disclosure](docs/AI_USAGE.md)
- [Project roadmap](docs/ROADMAP.md)

## Authorship

This project is authored by **Kamau Edwin Kamau**.

## License

PrideConnect is distributed under the MIT License; see [`LICENSE`](LICENSE). Kenya Airways names and marks belong to their respective owners. This project is not affiliated with or endorsed by Kenya Airways.
