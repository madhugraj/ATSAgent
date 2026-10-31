# ATSIQ — GCP deployment handoff (z-atsiq.yavar.ai)

Instructions for DevOps to deploy the ATSIQ ATS to a GCP cluster under the domain **z-atsiq.yavar.ai** (DNS labels are case-insensitive; lowercase used throughout).

## 1. Source

|                             |                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Git repo                    | https://github.com/madhu-yavar/yavar-ats.git                                                    |
| Branch                      | `main` (deploy latest commit)                                                                   |
| App type                    | TanStack Start (React 19) SSR app on Nitro → plain **Node server** (`.output/server/index.mjs`) |
| Package manager             | Bun (lockfile `bun.lock`); runtime image needs only Node                                        |
| Database                    | Plain **PostgreSQL** (Drizzle ORM, SQL migrations in `drizzle/pg-migrations/`) — no Supabase DB |
| Auth                        | First-party password authentication and PostgreSQL-backed cookie sessions                       |
| Files (CV vault, templates) | S3-compatible object storage                                                                    |

A production `Dockerfile` is at the repo root. `vite build` produces a Node server (nitro `node-server` preset, already configured in `vite.config.ts`). Verified locally: `node .output/server/index.mjs` serves `/` and `/privacy` with HTTP 200.

## 2. GCP infrastructure to provision

| Component          | Suggestion                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster            | GKE (Autopilot is fine)                                                                                                                                                                |
| Database           | Cloud SQL for PostgreSQL (14+), **private IP**, database `atsiq`                                                                                                                       |
| Object storage     | GCS bucket `resumes` used in **S3-compatible mode** (enable HMAC key for a service account; endpoint `https://storage.googleapis.com`) — or in-cluster MinIO / any S3-compatible store |
| Secrets            | GCP Secret Manager → mounted as K8s Secrets                                                                                                                                            |
| DNS                | Cloud DNS record `z-atsiq.yavar.ai` → load-balancer IP                                                                                                                                 |
| TLS                | GCLB Ingress + `ManagedCertificate` (or cert-manager)                                                                                                                                  |
| Cron               | Cloud Scheduler (3 jobs, see §6)                                                                                                                                                       |
| Container registry | Artifact Registry                                                                                                                                                                      |

## 3. Build & run

**Image:**

```bash
gcloud builds submit \
  --tag REGION-docker.pkg.dev/PROJECT/REGISTRY/atsiq:TAG
```

Container: port **3000**, `HOST=0.0.0.0`. No `/health` endpoint exists — use `GET /` (HTTP 200) as readiness/liveness probe. One DB migration **Job per release** (below) must complete before rolling the Deployment.

**Optional — browser for website reads** (Organisation context agent): the reader renders client-built websites when Chrome or a Playwright Chromium is present in the image (`playwright` is already a dependency; add `bunx playwright install chromium --with-deps` to the image build, or bake Chrome). Without a browser the feature still works — client-rendered sites just yield only their meta lines, and static sites read fully.

**Migrations** (run once per release, before deploy). The schema source of truth is `drizzle/pg-migrations/` applied by `scripts/migrate-pg.mjs` (idempotent — safe to re-run; records applied files in `pg_migrations`). **Do NOT use `bunx drizzle-kit migrate`** — the runner is the only supported migration path:

```bash
DATABASE_URL="postgresql://USER:PASS@PRIVATE_IP:5432/atsiq" node scripts/migrate-pg.mjs
```

Recent additions to note per release: `0015_ai_usage_events.sql` (AI usage ledger backing the platform console) and `0016_scrub_model_ids.sql` (one-time vendor-name scrub of stage-event reasons). The ledger grows with AI traffic; if size ever matters, prune `ai_usage_events` older than your retention window — aggregates read it live.

## 4. Environment variables

### Required — app will not boot without these

| Variable                | Value / how to generate                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgresql://…` Cloud SQL private IP                                                  |
| `SESSION_SECRET`        | `openssl rand -hex 32` (must be ≥ 32 chars)                                            |
| `PUBLIC_SITE_URL`       | `https://z-atsiq.yavar.ai` (used in capture links, OAuth redirects, emails)            |
| `SECRET_ENCRYPTION_KEY` | Random 32-byte key used to encrypt organisation AI and integration credentials at rest |

### Object storage (required for CV upload / templates / brand assets)

| Variable                                    | Value                                                   |
| ------------------------------------------- | ------------------------------------------------------- |
| `S3_ENDPOINT`                               | `https://storage.googleapis.com` (or MinIO/R2 endpoint) |
| `S3_BUCKET`                                 | `resumes`                                               |
| `S3_REGION`                                 | any (default `us-east-1` works with GCS)                |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | GCS HMAC key pair                                       |

### Optional feature flags — the app boots without them; the feature stays dark

| Feature                                                              | Variables                                                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Social-profile public API allowance                                  | `GITHUB_TOKEN` (optional; raises GitHub API limits)                                                                                                                                    |
| LinkedIn org-level connect                                           | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI=https://z-atsiq.yavar.ai/api/public/linkedin/callback`, `LINKEDIN_SCOPES`, `LINKEDIN_STATE_SECRET` (random 32+) |
| Google Calendar / Meet 1-click                                       | `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`, `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`                                                                                                               |
| Microsoft Teams meeting                                              | `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`                                                                                                                           |
| Zoom meeting                                                         | `ZOOM_OAUTH_CLIENT_ID`, `ZOOM_OAUTH_CLIENT_SECRET`                                                                                                                                     |
| OAuth state signing (required if any meeting OAuth above is enabled) | `OAUTH_STATE_SECRET` (random 32+)                                                                                                                                                      |
| Google sign-in button                                                | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`                                                                                                                                 |
| Careers-inbox email webhook                                          | `INBOUND_EMAIL_SECRET` (random 32+), `INBOUND_EMAIL_DOMAIN`                                                                                                                            |
| Google for Jobs — tell Google when roles open/close (Indexing API)    | `GOOGLE_INDEXING_CREDENTIALS` (service-account JSON key, raw or base64; the account must be an **owner** of the `PUBLIC_SITE_URL` property in Search Console), optional `GOOGLE_INDEXING_DAILY_LIMIT` (default 180; Google's default quota is 200/day, shared by all organisations). Unset: roles are still listed from their apply page's structured data and found on Google's own crawl |
| Scheduler/cron routes                                                | `CRON_SECRET` (random 32+; optional `CRON_SECRET_PREVIOUS` for rotation)                                                                                               |
| Transactional email                                                  | `SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`), `EMAIL_FROM`                                                                                                               |
| Agent parallelism (optional) | `AGENT_CONCURRENCY` — runs one scheduler tick drives at the same time (default 6, 1–20); independent hiring needs each need their own. `AGENT_INLINE_KICK=0` turns off the instant start after a person acts (the scheduler alone drives runs) |
| Phone screening (the PBX extension the voice worker dials out from; docs/voice-screening-agent.md) | `SIP_SERVER`, `SIP_USER`, `SIP_PASSWORD` (all three, or none), optional `SIP_PORT` (5060), `SIP_AUTH_USER`, `SIP_DOMAIN`, `SIP_CALLER_NAME`, `SIP_PUBLIC_IP` (only for one-way audio behind NAT), `VOICE_MAX_CONCURRENT` (calls at once, default 2). The AI voice itself is each organisation's own credential (Integrations → AI model), never a deployment key |
| `/metrics` OpenMetrics scrape (§9)                                   | `METRICS_TOKEN` (random 32+; the scraper sends `Authorization: Bearer …`). Unset: `/metrics` answers 404                                                                              |
| Platform SLO alert webhook (§9)                                      | `PLATFORM_ALERT_WEBHOOK_URL`, `PLATFORM_ALERT_WEBHOOK_SECRET` (HMAC-SHA256 signing key; `X-ATSAgent-Signature: sha256=<hex>`, as agent alerts). Platform admins are e-mailed when `SMTP_URL` is set |
| Cloud Logging ↔ trace grouping                                       | `GOOGLE_CLOUD_PROJECT` (project id; adds `logging.googleapis.com/trace` to every log line that has a trace)                                                                            |

**Secrets to generate:** `SESSION_SECRET`, `SECRET_ENCRYPTION_KEY` (AES-256 key for credentials at rest; `openssl rand -base64 32`), `OAUTH_STATE_SECRET`, `LINKEDIN_STATE_SECRET`, `INBOUND_EMAIL_SECRET`, `CRON_SECRET`, `METRICS_TOKEN`, `PLATFORM_ALERT_WEBHOOK_SECRET` — stored in Secret Manager. `SECRET_ENCRYPTION_KEY` is mandatory before saving OAuth or AI credentials. Rotating it requires re-encrypting stored values.

### Organisation-owned AI credentials

Do not configure deployment-level Gemini, OpenAI or Anthropic keys. An authorised HR head or organisation owner selects Gemini, OpenAI or Claude in ATSIQ and stores that organisation's key through Integrations. The encrypted value is held in PostgreSQL and is resolved only for that organisation. Missing, invalid or quota-limited keys stop the requested AI operation with a clear error; the application never falls back to a shared platform key.

### Rate limiter — proxy positioning (required)

The in-process rate limiter keys on the client IP taken from the **right-most**
`X-Forwarded-For` hop (spoof-proof behind exactly one trusted proxy). Set:

```
TRUSTED_PROXY_COUNT=1     # number of trusted proxy hops (GKE L7 LB = 1)
```

The container must only be reachable **through** that proxy (no direct-to-node
traffic): a client that bypasses the LB can send an arbitrary XFF and rotate
limiter buckets. If you add a second proxy hop, raise the count to 2.

## 5. OAuth redirect URIs to register (per provider console)

All under the new domain:

- LinkedIn: `https://z-atsiq.yavar.ai/api/public/linkedin/callback`
- Google Calendar: `https://z-atsiq.yavar.ai/api/public/integrations/google/callback`
- Microsoft: `https://z-atsiq.yavar.ai/api/public/integrations/microsoft/callback`
- Zoom: `https://z-atsiq.yavar.ai/api/public/integrations/zoom/callback`

## 6. Cron (Cloud Scheduler, auth via header)

All endpoints expect `Authorization: Bearer $CRON_SECRET`:

| Job                       | Target                                                | Typical cadence |
| ------------------------- | ----------------------------------------------------- | --------------- |
| Careers-inbox scoring     | `https://z-atsiq.yavar.ai/api/public/inbox-sync`      | every 5–15 min  |
| Candidate re-sync/scoring | `https://z-atsiq.yavar.ai/api/public/sync-candidates` | hourly          |
| Candidate email outbox    | `https://z-atsiq.yavar.ai/api/public/process-email-outbox` | every 5 min |
| HRMS employee sync        | `https://z-atsiq.yavar.ai/api/public/sync-hrms`       | every 15 min    |
| Job-board application sync | `https://z-atsiq.yavar.ai/api/public/board-sync`     | every 15 min    |

## 7. Example Kubernetes objects (sketch)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atsiq
spec:
  replicas: 2
  selector: { matchLabels: { app: atsiq } }
  template:
    metadata:
      labels: { app: atsiq }
    spec:
      containers:
        - name: atsiq
          image: REGION-docker.pkg.dev/PROJECT/REGISTRY/atsiq:TAG
          ports: [{ containerPort: 3000 }]
          envFrom:
            - secretRef: { name: atsiq-env } # all vars from §4
          readinessProbe:
            httpGet: { path: /, port: 3000 }
            initialDelaySeconds: 5
          livenessProbe:
            httpGet: { path: /, port: 3000 }
            initialDelaySeconds: 15
          resources:
            requests: { cpu: "500m", memory: "512Mi" }
```

Plus a `Service` (port 80 → 3000) and an `Ingress` with `ManagedCertificate` for `z-atsiq.yavar.ai` and a Cloud DNS A record pointing at the ingress IP.

### Voice worker (phone screening — optional)

The same image runs the voice worker that places phone screening calls
(docs/voice-screening-agent.md). It has no Service or Ingress: it only dials
out (SIP UDP 5060 and RTP to the PBX). Verified on GKE through Cloud NAT with
no extra networking. A person creates it and its Secret; `scripts/deploy.sh`
then rolls it with every release.

```yaml
# kubectl -n atsiq create secret generic atsiq-voice --from-literal=SIP_SERVER=… \
#   --from-literal=SIP_USER=… --from-literal=SIP_PASSWORD=… [--from-literal=SIP_CALLER_NAME=…]
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atsiq-voice-worker
spec:
  replicas: 1 # calls are claimed atomically; more replicas = more simultaneous calls
  selector: { matchLabels: { app: atsiq-voice-worker } }
  template:
    metadata:
      labels: { app: atsiq-voice-worker }
    spec:
      # A call in progress finishes before the pod stops (policy maximum is 30 minutes).
      terminationGracePeriodSeconds: 1900
      containers:
        - name: voice-worker
          image: REGION-docker.pkg.dev/PROJECT/REGISTRY/atsiq:TAG
          command: ["node", "/app/.output/voice-worker/index.mjs"]
          envFrom:
            - secretRef: { name: atsiq-env } # DATABASE_URL, SESSION_SECRET, SECRET_ENCRYPTION_KEY, …
            - secretRef: { name: atsiq-voice } # SIP_* (and VOICE_MAX_CONCURRENT)
          resources:
            requests: { cpu: "250m", memory: "512Mi" }
```

The AI voice uses each organisation's own credential (Integrations → AI model);
the worker holds none. Without `SIP_*` the worker exits at start with a clear
log line.

## 8. First-boot checklist

1. Migration Job ran clean against `atsiq` DB.
2. `https://z-atsiq.yavar.ai` loads; sign-up, confirmation, sign-in, session renewal, sign-out and password recovery work through the first-party auth routes.
3. Create first org/user, upload a CV — confirms `DATABASE_URL` + S3/HMAC path.
4. Trigger one cron route manually with the bearer token → HTTP 200.
5. Smoke: `/`, `/candidates`, `/requisitions`, `/privacy` → HTTP 200.

## 9. Monitoring, SLOs and alerting

The app writes one JSON log line per request (`msg: "http.request"`: method, route template with ids replaced by `:id`, `route_group`, status, `status_class`, `duration_ms`, `trace_id`) and returns `x-request-id` / `traceparent` on every response. Searching Logs Explorer for `jsonPayload.trace_id="<x-request-id>"` returns every line of that request, including the agent runs it started.

Service level objectives are defined in `src/server/slo.ts`: server-function availability 99 % (no 5xx), server-function latency 95 % within 2.5 s, agent run success 95 % — each over 30 days. Platform super admins see SLI vs objective, error budget left and burn rates on **Platform → Service health** (`/platform-health`). The app's own multi-window burn-rate evaluator runs with the agent scheduler tick and alerts platform admins by e-mail, the optional signed `PLATFORM_ALERT_WEBHOOK_URL`, an ERROR log line `slo.burn_alert` and `audit_log`.

Cloud Monitoring dashboard and alert policies are kept as code in `infra/monitoring/` (log-based metrics, dashboard JSON, burn-rate / latency / scheduler-stalled / app-burn-alert policies, optional Managed Prometheus `PodMonitoring` for `/metrics`). Apply them with the steps in `infra/monitoring/README.md` after the first deploy, and register the notification channel for on-call. Metric labels are fixed and low-cardinality (`route_group`, `method`, `status_class`); never add route, id, org or user labels.

Each replica writes its per-minute request counts to `service_request_minutes` (migration `0053_service_slo.sql`, kept 35 days), so the SLO panel covers all replicas.

