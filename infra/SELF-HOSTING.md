# ATSIQ self-hosting

The application is fully portable: TanStack Start (React 19 SSR on Nitro) as a
plain Node server, ordinary PostgreSQL via drizzle, S3-compatible object
storage, SMTP and first-party cookie auth — no hosted-platform SDKs. This
document is the step-by-step Cloud Run plan; `DEPLOYMENT-GCP.md`
remains the reference for the full GCP environment (GKE variant, OAuth
redirects, cron jobs).

## 0. Runtime dependencies

| Need                                              | Provider                             | Env                                                                                 |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| Postgres 14+                                      | Cloud SQL (or any in-house PG)       | `DATABASE_URL`                                                                      |
| Sessions/auth                                     | The app itself (`sessions` table)    | `SESSION_SECRET`                                                                    |
| Object storage (CV vault, templates, brand logos) | GCS with HMAC keys, MinIO, or any S3 | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Transactional email                               | Any SMTP                             | `SMTP_URL`, `EMAIL_FROM`                                                            |
| Encryption of stored org credentials              | App itself                           | `SECRET_ENCRYPTION_KEY`                                                             |
| Public URL                                        | Your DNS                             | `PUBLIC_SITE_URL`                                                                   |

Optional feature flags (LinkedIn/Google/Teams/Zoom OAuth, cron secrets) are
listed in `DEPLOYMENT-GCP.md` §4 and stay dark when unset.

## 1. Database

The schema source of truth is `drizzle/pg-migrations/`, applied by the
idempotent runner (safe to re-run; it records applied files in `pg_migrations`):

```bash
DATABASE_URL="postgres://…/atsiq" bun scripts/migrate-pg.mjs
```

To bring existing data across, restore a data-only dump over that schema:

```bash
pg_restore --data-only --no-owner -d "$DATABASE_URL" existing.dump
```

## 2. One-time GCP setup (Cloud Run path)

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com

# Database
gcloud sql instances create atsiq --database-version=POSTGRES_14 --tier=db-g1-small --region=REGION
gcloud sql databases create atsiq --instance=atsiq
gcloud sql users create atsiq --instance=atsiq --password=…
# Connection string for private IP via the Cloud SQL connector:
#   postgres://atsiq:…@/atsiq?host=/cloudsql/PROJECT:REGION:atsiq

# Secrets (values per DEPLOYMENT-GCP.md §4)
printf %s "postgres://…" | gcloud secrets create atsiq-database-url --data-file=-
printf %s "$(openssl rand -hex 32)" | gcloud secrets create atsiq-session-secret --data-file=-
printf %s "$(openssl rand -base64 32)" | gcloud secrets create atsiq-secret-encryption-key --data-file=-
printf %s "smtps://user:pass@smtp.example.com:465" | gcloud secrets create atsiq-smtp-url --data-file=-
# + atsiq-inbound-email-secret, atsiq-cron-secret (optional features)

# Container registry
gcloud artifacts repositories create atsiq --repository-format=docker --location=REGION
```

## 3. Continuous deployment

`.github/workflows/deploy.yml` (already in this repo) builds the Dockerfile,
runs `scripts/migrate-pg.mjs` against the database, and deploys to Cloud Run on
every push to `main`. Enable it by adding the repo secrets `GCP_PROJECT`,
`GCP_SA_KEY` and the variables `GCP_REGION`, `GCP_REPOSITORY`,
`DEPLOY_ENABLED=true` (see the header of the workflow file).

## 4. DNS cut-over

1. Deploy and smoke-test on the Cloud Run URL first: `/` 200, sign-in,
   `/platform`, upload a CV.
2. In Cloudflare, switch the `atsiq.yavar.ai` origin to the Cloud Run URL (or
   add a CNAME to `ghs.googlehosted.com` and let Cloudflare proxy it).
3. Keep the previous origin available until a week of clean operation, then
   retire it.
