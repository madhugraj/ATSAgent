# ATSIQ — GCP deployment handoff for DevOps

**Goal:** deploy ATSIQ (the ATS web app) to Google Cloud Run under **https://atsiq.yavar.ai**, backed by Cloud SQL PostgreSQL. The application is fully portable — a plain Node server + ordinary PostgreSQL + S3-compatible storage + SMTP. It has **no runtime dependency on Lovable or Supabase** (verified: the production build boots with only `DATABASE_URL` and `SESSION_SECRET` set).

| | |
|---|---|
| Source repo | https://github.com/madhu-yavar/yavar-ats — branch `main` (deploy latest commit) |
| App type | TanStack Start (React 19 SSR on Nitro) → plain **Node server** (`.output/server/index.mjs`) |
| Container | `Dockerfile` at repo root — multi-stage, final image `node:22-slim`, listens on **port 3000**, `HOST=0.0.0.0` |
| Database | Ordinary **PostgreSQL 14+** (drizzle ORM). Schema source of truth: `drizzle/pg-migrations/` applied by `scripts/migrate-pg.mjs` (idempotent). **Do NOT use `drizzle-kit migrate`** — the runner is the only supported migration path. |
| Auth | First-party: scrypt password hashes in the `users` table, httpOnly `atsiq_session` cookie, DB-backed `sessions` table. No external identity provider. |
| Object storage (CV vault, template sources, brand logos) | Any S3-compatible store. Recommended: **GCS bucket with HMAC keys**. |
| Email | Any SMTP relay (`SMTP_URL`). Used for: registration confirmation, invitations, password reset, org approval notices, and the queued candidate emails (acknowledgment, stage update, interview invitation, offer) drained by the `process-email-outbox` cron. |
| Health probe | **`GET /`** (HTTP 200). There is no `/health` endpoint. |
| Environment variables | **Copy-ready template: `infra/env.production.example`** — the annotated production `.env`. Only `DATABASE_URL` + `SESSION_SECRET` are required to boot; `SMTP_URL` is required for email delivery. |

---

## 0. Inputs DevOps needs from the product owner

| Input | Notes |
|---|---|
| GCP project ID + region | e.g. `yavar-studio`, region `asia-south1` |
| DNS control for `atsiq.yavar.ai` | Currently proxied through **Cloudflare**; origin must be repointed at the Cloud Run URL at cut-over |
| SMTP credentials | Host/port/user/pass (or an existing corporate relay). Password-reset and invitation emails depend on this |
| A `pg_dump` of any existing data | Needed only when migrating existing users, organisations and candidates — see §3 |

---

## 1. Provision GCP resources

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com

# --- Cloud SQL (PostgreSQL 14+) ---
gcloud sql instances create atsiq --database-version=POSTGRES_14 \
  --tier=db-g1-small --region=REGION
gcloud sql databases create atsiq --instance=atsiq
gcloud sql users create atsiq --instance=atsiq --password='<choose-strong-password>'

# --- Container registry ---
gcloud artifacts repositories create atsiq \
  --repository-format=docker --location=REGION
```

For the app → database connection, prefer the **Cloud SQL language connector**
(the Node app already supports it via the unix-socket host format):

```
postgres://atsiq:<password>@/atsiq?host=/cloudsql/PROJECT:REGION:atsiq
```

(The Cloud Run service gets `--add-cloudsql-instances` and the runtime service
account needs role `roles/cloudsql.client`.)

If you prefer private IP + Serverless VPC access instead, that also works —
just make `DATABASE_URL` a normal private-IP URL.

## 2. Create Secret Manager secrets

Names matter — the CI workflow (` .github/workflows/deploy.yml`) mounts them by these exact names:

```bash
# 1. Database URL (the value from §1)
printf %s "postgres://atsiq:<pw>@/atsiq?host=/cloudsql/PROJECT:REGION:atsiq" \
  | gcloud secrets create atsiq-database-url --data-file=-

# 2. Session signing/derivation secret — MUST be >= 32 chars
printf %s "$(openssl rand -hex 32)" | gcloud secrets create atsiq-session-secret --data-file=-

# 3. AES-256 key encrypting organisation AI/integration credentials at rest.
#    Losing/rotating it invalidates stored credentials — back it up.
printf %s "$(openssl rand -base64 32)" | gcloud secrets create atsiq-secret-encryption-key --data-file=-

# 4. SMTP relay (only if email should work — required for signups/invites/resets)
printf %s "smtps://user:pass@smtp.example.com:465" | gcloud secrets create atsiq-smtp-url --data-file=-

# 5+ Optional feature flags (app boots fine without them):
printf %s "$(openssl rand -hex 32)" | gcloud secrets create atsiq-inbound-email-secret --data-file=-
printf %s "$(openssl rand -hex 32)" | gcloud secrets create atsiq-cron-secret --data-file=-
```

Also `EMAIL_FROM` (e.g. `ATSIQ <noreply@yavar.ai>`) can be passed as a plain
env var. Ensure SPF/DKIM exist for whichever domain sends mail.

## 3. Schema + data

**Fresh database (no data to keep):**

```bash
git clone https://github.com/madhu-yavar/yavar-ats && cd yavar-ats
bun install --frozen-lockfile   # or: npm i -g bun first
DATABASE_URL="postgres://atsiq:<pw>@/atsiq?host=/cloudsql/PROJECT:REGION:atsiq" \
  bun scripts/migrate-pg.mjs
```

Safe to re-run; it records applied files in a `pg_migrations` table.

**Existing data:** take a dump from the current database, then:

```bash
# Schema first (same command as above), then data-only restore:
pg_restore --data-only --no-owner -d "$DATABASE_URL" existing.dump
# (if they provide plain SQL instead: psql -d "$DATABASE_URL" -f dump.sql)
```

**Verify the restore** (counts must match the source database):

```sql
SELECT count(*) FROM users;          -- expect ≥ 1 (madhu.r@yavar.ai)
SELECT name, status FROM organizations;
SELECT count(*) FROM candidates;
SELECT count(*) FROM requisitions;
```

Known rows: user `madhu.r@yavar.ai` (platform super admin), organisation
"Yavar Technologies" (status `active`, owner = madhu.r@yavar.ai).

## 4. Deploy

### Option A — CI (recommended once provisioned)

Add to the GitHub repo (Settings → Secrets and variables → Actions):

| Type | Name | Value |
|---|---|---|
| Secret | `GCP_PROJECT` | project id |
| Secret | `GCP_SA_KEY` | JSON key of a service account with roles: Cloud Run Admin, Artifact Registry Writer, Cloud SQL Client, Secret Manager Secret Accessor |
| Variable | `GCP_REGION` | e.g. `asia-south1` |
| Variable | `GCP_REPOSITORY` | `atsiq` |
| Variable | `DEPLOY_ENABLED` | `true` |

Every push to `main` then: migrates the database (`scripts/migrate-pg.mjs`), builds the Dockerfile, pushes to Artifact Registry, deploys the Cloud Run service with the secrets from §2.

### Option B — manual deploy

```bash
gcloud auth configure-docker REGION-docker.pkg.dev
IMAGE="REGION-docker.pkg.dev/PROJECT/atsiq/atsiq:$(git rev-parse --short HEAD)"
docker build -t "$IMAGE" . && docker push "$IMAGE"

gcloud run deploy atsiq \
  --image "$IMAGE" --region REGION --port 3000 --allow-unauthenticated \
  --add-cloudsql-instances "PROJECT:REGION:atsiq" \
  --set-secrets "DATABASE_URL=atsiq-database-url:latest,SESSION_SECRET=atsiq-session-secret:latest,SECRET_ENCRYPTION_KEY=atsiq-secret-encryption-key:latest,SMTP_URL=atsiq-smtp-url:latest" \
  --set-env-vars "PUBLIC_SITE_URL=https://atsiq.yavar.ai,TRUSTED_PROXY_COUNT=1" \
  --quiet
```

> **`TRUSTED_PROXY_COUNT=1` is required** (one proxy hop in front of the app).
> The service must only be reachable through that proxy.

Scaling guidance: start with `--min-instances 1 --max-instances 3 --cpu 1 --memory 1Gi`. More replicas are fine — sessions are DB-backed, the app is stateless.

## 5. Smoke tests (before DNS cut-over)

On the Cloud Run URL:

1. `GET /` → 200 (landing page)
2. Sign in with an existing account → workspace loads
3. `GET /platform` → platform console lists "Yavar Technologies — Active"
4. Upload a CV → file lands in the object-storage bucket (validates S3/HMAC path)
5. Trigger an email (e.g. "Forgot your password?") → mail arrives
6. `POST /api/public/inbox-sync` with `Authorization: Bearer <cron-secret>` → 200 (optional feature)
7. `POST /api/public/sync-hrms` with `Authorization: Bearer <cron-secret>` → 200 (no-op until an organisation enables an HRMS connection)
8. `POST /api/public/board-sync` with `Authorization: Bearer <cron-secret>` → 200 summary (no-op until a job-board connection is enabled)

## 6. DNS cut-over

1. In Cloudflare, repoint `atsiq.yavar.ai` to the Cloud Run URL
   (`https://atsiq.yavar.ai` → CNAME `ghs.googlehosted.com` proxied, or origin
   rule to the `*.run.app` URL).
2. Keep the **previous origin available** for a week of clean operation, then
   retire it.
3. Rollback = switch the Cloudflare origin back to the previous origin.

## 7. Scheduled jobs (optional)

Cloud Scheduler (all call the app with `Authorization: Bearer <value of atsiq-cron-secret>`):

| Schedule | Target |
|---|---|
| every 5–15 min | `https://atsiq.yavar.ai/api/public/inbox-sync` (scores candidates that arrived through the careers-inbox webhook) |
| hourly | `https://atsiq.yavar.ai/api/public/sync-candidates` |
| every 5 min | `https://atsiq.yavar.ai/api/public/process-email-outbox` (drains the candidate email queue) |
| every 15 min | `https://atsiq.yavar.ai/api/public/sync-hrms` (refreshes the HRMS employee caches) |
| every 15 min | `https://atsiq.yavar.ai/api/public/board-sync` (job-board application poll/backfill + webhook-event retention) |
| every 5 min | `https://atsiq.yavar.ai/api/public/screening-prep` (prepares screening kits for shortlisted candidates in the background; retries ≤3) |
| every 1 min | `https://atsiq.yavar.ai/api/public/agent-tick` (drives the agent runtime: claims queued runs, resumes runs after a human decision; no-op until agents are enabled) |

Registering these in Cloud Scheduler is a **devops step** — the app only serves the
routes. Until `screening-prep` is registered, screening kits are still built when a
recruiter presses "Prepare questions" (degraded, not broken); after registration the
first sweep backfills every shortlisted candidate missing a kit (AI cost: one
`screening_kit` call per candidate on the organisation's own key, throttled to ≤100
per sweep, fully ledgered in `ai_usage_events`).

## 8. Notes & gotchas

- **Do not run `drizzle-kit migrate` against this database.** The schema path is
  `drizzle/pg-migrations/` + `scripts/migrate-pg.mjs` only. Future schema
  changes arrive as new numbered `.sql` files in that folder — just re-run the
  script.
- **Rebuild the Capture companion before each deploy**: `public/atsiq-capture.zip`
  is gitignored, so it is not updated by pulls — regenerate it from the
  extension source whenever `extension/` changes:
  `cd extension && zip -q ../public/atsiq-capture.zip manifest.json background.js popup.js popup.html`.
  The Integrations "Download the companion" button serves this file verbatim.
- `SECRET_ENCRYPTION_KEY` decrypts organisation-level AI/integration
  credentials. Back it up; rotating it requires re-encrypting stored values.
- Session cookies are `SameSite=None; Secure` over HTTPS — fine behind
  Cloudflare/Cloud Run.
- The app is stateless; any replica can serve any request. Log stream to Cloud
  Logging includes auth-failure and query-error details.
- Reference documents in the repo: `infra/SELF-HOSTING.md` (exit plan),
  `DEPLOYMENT-GCP.md` (older GKE-variant reference, env-var details §4,
  OAuth redirect URIs §5).
