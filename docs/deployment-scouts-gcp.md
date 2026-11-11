# Scouts on Google Cloud — DevOps runbook (www.scouts.yavar.ai)

From a fresh clone of the repository to a production deployment on GCP with
continuous delivery. Written for the DevOps team; every command is meant to be
run as written once the placeholders in §1 are filled in.

> The product is **Scouts** (the repository and internal names still say ATSAgent /
> ATSIQ). Public address: **https://www.scouts.yavar.ai**, with `scouts.yavar.ai`
> answering too.

---

## 0. What you are deploying

One container image, run as three workloads, plus scheduled HTTP calls:

```
                         Internet
                            │  HTTPS (Google-managed certificate)
                 ┌──────────▼───────────┐
                 │ Global HTTP(S) LB    │  static IP "scouts-ip"
                 │ www.scouts.yavar.ai  │  (Ingress, HTTP→HTTPS redirect)
                 └──────────┬───────────┘
                            │ :80 → :3000
   Cloud Scheduler ──────►  │  (cron routes, Bearer CRON_SECRET)
                 ┌──────────▼───────────┐        ┌──────────────────────┐
                 │ scouts-app  (2–6)    │──────► │ scouts-parser (2)    │
                 │ node .output/server  │  :8080 │ no egress, no secrets│
                 └───┬──────────┬───────┘        └──────────────────────┘
                     │          │
        private IP   │          │ S3 API (HMAC)
     ┌───────────────▼──┐   ┌───▼──────────────┐
     │ Cloud SQL        │   │ GCS bucket       │
     │ PostgreSQL 15    │   │ (CVs, templates) │
     └───────▲──────────┘   └──────────────────┘
             │
     ┌───────┴──────────────┐   SIP 5060/UDP + RTP   ┌───────────────┐
     │ scouts-voice-worker  │──── via Cloud NAT ────►│ Organisation's │
     │ (1; AI phone calls)  │   (static egress IP)   │ PBX / SIP trunk│
     └──────────────────────┘                        └───────────────┘
```

| Workload                | Command (same image)                                 | Port | Notes                                                                                                                               |
| ----------------------- | ---------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **scouts-app**          | `node .output/server/index.mjs` (default)            | 3000 | Web app, APIs, webhooks. Stateless; scale horizontally.                                                                             |
| **scouts-parser**       | `node .output/parser-worker/index.mjs`               | 8080 | Parses CVs and documents in a sandbox: **no network egress**, no DB, only `PARSER_TOKEN`.                                           |
| **scouts-voice-worker** | `node .output/voice-worker/index.mjs`                | —    | Places the AI screening, scheduling and pay calls over SIP. Long-lived; finishes calls before stopping. Optional (phone screening). |
| **migrate** (Job)       | `bun scripts/migrate-pg.mjs` (`migrate` build stage) | —    | Runs once per release, before the rollout.                                                                                          |

**Why GKE (not Cloud Run):** the voice worker is a long-running process that
holds SIP/RTP sessions over UDP for minutes at a time; Cloud Run is
request-scoped and unsuitable for it. The app and parser could run on Cloud Run
(`.github/workflows/deploy.yml` exists for that), but one GKE Autopilot cluster
keeps all three together, with one network policy model and one pipeline. This
runbook is GKE Autopilot.

**AI keys:** none are configured on the platform. Each organisation stores its
own AI provider key in the app (Integrations → AI model), encrypted with
`SECRET_ENCRYPTION_KEY`. Never add deployment-wide AI keys.

---

## 1. Inputs to collect before starting

| Item                              | Example / who provides it                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GCP project                       | `yavar-scouts-prod` (new project recommended)                                                                                                                                           |
| Region                            | `asia-south1` (Mumbai)                                                                                                                                                                  |
| Repository                        | `https://github.com/madhugraj/ATSAgent` — deploy branch `main`                                                                                                                          |
| DNS zone for `yavar.ai`           | Who manages it (Cloud DNS or external registrar)                                                                                                                                        |
| SMTP for transactional mail       | `smtps://user:pass@smtp.provider.com:465` + a verified `EMAIL_FROM` (e.g. `Scouts <no-reply@scouts.yavar.ai>`)                                                                          |
| SIP trunk / PBX (phone screening) | `SIP_SERVER`, `SIP_PORT`, `SIP_USER`, `SIP_PASSWORD`, `SIP_AUTH_USER`, `SIP_DOMAIN`, `SIP_CALLER_NAME` — from the telephony provider; they must allow-list our **static NAT IP** (§3.3) |
| OAuth apps (optional features)    | Google sign-in, Google Calendar, Microsoft, Zoom, LinkedIn — client id/secret each (§8)                                                                                                 |
| First platform admin              | Owner e-mail for `bootstrap-org.ts` (§7)                                                                                                                                                |

Placeholders used below — export them in your shell:

```bash
export PROJECT=yavar-scouts-prod
export REGION=asia-south1
export ZONE_REGION=$REGION
export CLUSTER=scouts
export REPO=scouts            # Artifact Registry repository
export SQL_INSTANCE=scouts-pg
export BUCKET=yavar-scouts-files
export DOMAIN=www.scouts.yavar.ai
export APEX=scouts.yavar.ai
```

---

## 2. Clone and verify the build locally

Requirements: Bun ≥ 1.3, Node 22, Docker, gcloud, kubectl.

```bash
git clone https://github.com/madhugraj/ATSAgent.git scouts && cd scouts
git checkout main
bun install --frozen-lockfile
bun run typecheck && bun run lint
bun run build          # → .output/server, .output/parser-worker, .output/voice-worker
```

Container images (the same as CI builds):

```bash
docker build -t scouts:local .                     # runtime image (app/parser/voice)
docker build --target migrate -t scouts-migrate:local .   # migration runner
```

Quick local run against a throw-away Postgres (optional):

```bash
docker run --rm -d --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:15
DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres bun scripts/migrate-pg.mjs
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://postgres:pg@host.docker.internal:5432/postgres \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  -e PUBLIC_SITE_URL=http://localhost:3000 scouts:local
curl -sf localhost:3000/ >/dev/null && echo OK
```

The browser companion download (`public/atsiq-capture.zip`) is generated from
`extension/` and is not committed; the pipeline builds it (§9) — locally:
`cd extension && zip -qr ../public/atsiq-capture.zip manifest.json background.js popup.js popup.html portal-fill.js`.

---

## 3. Provision GCP

### 3.1 Project and APIs

```bash
gcloud config set project $PROJECT
gcloud services enable container.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  compute.googleapis.com servicenetworking.googleapis.com dns.googleapis.com \
  cloudscheduler.googleapis.com iamcredentials.googleapis.com \
  monitoring.googleapis.com logging.googleapis.com
```

### 3.2 Network

```bash
gcloud compute networks create scouts-vpc --subnet-mode=custom
gcloud compute networks subnets create scouts-gke --network scouts-vpc \
  --region $REGION --range 10.10.0.0/20 \
  --secondary-range pods=10.20.0.0/14,services=10.24.0.0/20 \
  --enable-private-ip-google-access
# Private services access for Cloud SQL private IP
gcloud compute addresses create google-managed-services-scouts \
  --global --purpose VPC_PEERING --prefix-length 16 --network scouts-vpc
gcloud services vpc-peerings connect --service servicenetworking.googleapis.com \
  --ranges google-managed-services-scouts --network scouts-vpc
```

### 3.3 Cloud NAT with a static egress IP (outbound internet + SIP)

Pods are private; all outbound traffic (SMTP, OAuth providers, job boards, the
organisations' AI providers, official labour-law sources, and SIP/RTP to the PBX)
leaves through Cloud NAT. Give it a **static IP** so the telephony provider and
any partner can allow-list it.

```bash
gcloud compute addresses create scouts-nat-ip --region $REGION
gcloud compute routers create scouts-router --network scouts-vpc --region $REGION
gcloud compute routers nats create scouts-nat --router scouts-router --region $REGION \
  --nat-custom-subnet-ip-ranges scouts-gke,scouts-gke:pods \
  --nat-external-ip-pool scouts-nat-ip \
  --enable-endpoint-independent-mapping \
  --min-ports-per-vm 4096 \
  --udp-idle-timeout 300s
gcloud compute addresses describe scouts-nat-ip --region $REGION --format 'value(address)'
```

Endpoint-independent mapping and the longer UDP idle timeout keep RTP audio
flowing both ways during a call. Give this IP to the SIP provider for
allow-listing, and set it as `SIP_PUBLIC_IP` (§5) if audio is one-way.

### 3.4 GKE Autopilot cluster (private nodes)

```bash
gcloud container clusters create-auto $CLUSTER --region $REGION \
  --network scouts-vpc --subnetwork scouts-gke \
  --cluster-secondary-range-name pods --services-secondary-range-name services \
  --enable-private-nodes --master-ipv4-cidr 172.16.0.0/28 \
  --release-channel regular
gcloud container clusters get-credentials $CLUSTER --region $REGION
```

Autopilot runs Dataplane V2, so the parser's NetworkPolicy (deny all egress) is
enforced. If GitHub-hosted runners must reach the control plane, add
`--enable-master-authorized-networks` with your runner ranges, or use the
private-cluster approach in §9.4.

### 3.5 Cloud SQL for PostgreSQL (private IP)

```bash
gcloud sql instances create $SQL_INSTANCE --database-version POSTGRES_15 \
  --region $REGION --tier db-custom-2-7680 --availability-type REGIONAL \
  --network scouts-vpc --no-assign-ip \
  --storage-size 50 --storage-auto-increase \
  --backup-start-time 20:30 --enable-point-in-time-recovery \
  --maintenance-window-day SUN --maintenance-window-hour 21
gcloud sql databases create scouts --instance $SQL_INSTANCE
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=')
gcloud sql users create scouts --instance $SQL_INSTANCE --password "$DB_PASS"
SQL_IP=$(gcloud sql instances describe $SQL_INSTANCE --format 'value(ipAddresses[0].ipAddress)')
echo "DATABASE_URL=postgres://scouts:${DB_PASS}@${SQL_IP}:5432/scouts"
```

Start with 2 vCPU / 7.5 GB, regional (HA). The schema is plain PostgreSQL; there
is no ORM-managed migration — only `scripts/migrate-pg.mjs` (§6).

### 3.6 Object storage (S3-compatible GCS)

```bash
gcloud storage buckets create gs://$BUCKET --location $REGION \
  --uniform-bucket-level-access --public-access-prevention
gcloud iam service-accounts create scouts-storage --display-name "Scouts object storage"
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member serviceAccount:scouts-storage@$PROJECT.iam.gserviceaccount.com \
  --role roles/storage.objectAdmin
gcloud storage hmac create scouts-storage@$PROJECT.iam.gserviceaccount.com
# → accessId = S3_ACCESS_KEY_ID, secret = S3_SECRET_ACCESS_KEY (shown once)
```

### 3.7 Artifact Registry and the static IP

```bash
gcloud artifacts repositories create $REPO --repository-format docker --location $REGION
gcloud compute addresses create scouts-ip --global
gcloud compute addresses describe scouts-ip --global --format 'value(address)'
```

### 3.8 DNS

Create two **A records** to the global IP from §3.7 (in Cloud DNS or at the
registrar that serves `yavar.ai`):

| Name                   | Type | Value         |
| ---------------------- | ---- | ------------- |
| `www.scouts.yavar.ai.` | A    | `<scouts-ip>` |
| `scouts.yavar.ai.`     | A    | `<scouts-ip>` |

The Google-managed certificate (§6) provisions only after both resolve to this
IP; it can take 15–60 minutes.

---

## 4. Secrets

All secrets live in **Secret Manager**; the pipeline materialises them as
Kubernetes Secrets on every deploy (§9). Three Secret Manager secrets:

| Secret Manager name   | Format                             | Becomes K8s Secret                                         | Used by                        |
| --------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `scouts-env`          | dotenv file (`KEY=value` per line) | `scouts-env`                                               | app, voice worker, migrate Job |
| `scouts-voice`        | dotenv file                        | `scouts-voice`                                             | voice worker                   |
| `scouts-parser-token` | one random value                   | `scouts-parser` (`PARSER_TOKEN`) and added to `scouts-env` | app, parser                    |

Generate the random values:

```bash
openssl rand -hex 32        # SESSION_SECRET, CRON_SECRET, OAUTH_STATE_SECRET,
                            # LINKEDIN_STATE_SECRET, INBOUND_EMAIL_SECRET, METRICS_TOKEN,
                            # PLATFORM_ALERT_WEBHOOK_SECRET, PARSER_TOKEN
openssl rand -base64 32     # SECRET_ENCRYPTION_KEY (AES-256; keep a sealed backup —
                            # losing it makes every stored credential unreadable)
```

Create them (example — fill the file from §5 first; never commit it):

```bash
gcloud secrets create scouts-env --replication-policy automatic --data-file scouts.env
gcloud secrets create scouts-voice --replication-policy automatic --data-file scouts-voice.env
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create scouts-parser-token --data-file -
# Later changes: gcloud secrets versions add scouts-env --data-file scouts.env
shred -u scouts.env scouts-voice.env
```

---

## 5. Environment variables

`scouts.env` (→ Secret Manager `scouts-env`). Values the app validates at boot are
marked **required**.

```dotenv
# --- required
DATABASE_URL=postgres://scouts:<pw>@<cloud-sql-private-ip>:5432/scouts
SESSION_SECRET=<openssl rand -hex 32>
SECRET_ENCRYPTION_KEY=<openssl rand -base64 32>
PUBLIC_SITE_URL=https://www.scouts.yavar.ai

# --- behind the Google load balancer (exactly one trusted proxy hop)
TRUSTED_PROXY_COUNT=1
RATE_LIMIT_STORE=postgres          # one rate limit across all app replicas
NODE_ENV=production
LOG_LEVEL=info
GOOGLE_CLOUD_PROJECT=yavar-scouts-prod   # groups log lines by trace

# --- object storage (GCS in S3 mode)
S3_ENDPOINT=https://storage.googleapis.com
S3_BUCKET=yavar-scouts-files
S3_REGION=auto
S3_ACCESS_KEY_ID=<hmac access id>
S3_SECRET_ACCESS_KEY=<hmac secret>

# --- e-mail (sign-up confirmation, password reset, candidate mail)
SMTP_URL=smtps://user:pass@smtp.example.com:465
EMAIL_FROM=Scouts <no-reply@scouts.yavar.ai>

# --- scheduler (Cloud Scheduler sends Authorization: Bearer <CRON_SECRET>)
CRON_SECRET=<openssl rand -hex 32>
# CRON_SECRET_PREVIOUS=<old value during rotation>

# --- sandboxed parser (same value as Secret Manager scouts-parser-token)
PARSER_TOKEN=<value>
# PARSER_URL is set in the Deployment (cluster-internal address)

# --- monitoring (optional)
METRICS_TOKEN=<openssl rand -hex 32>
# PLATFORM_ALERT_WEBHOOK_URL=https://…
# PLATFORM_ALERT_WEBHOOK_SECRET=<openssl rand -hex 32>

# --- careers inbox webhook (optional)
# INBOUND_EMAIL_SECRET=<openssl rand -hex 32>
# INBOUND_EMAIL_DOMAIN=jobs.scouts.yavar.ai

# --- meeting and job-board integrations (optional; each feature stays dark without it) — §8
# GOOGLE_OAUTH_CLIENT_ID=…            GOOGLE_OAUTH_CLIENT_SECRET=…
# GOOGLE_CALENDAR_OAUTH_CLIENT_ID=…   GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=…
# MICROSOFT_OAUTH_CLIENT_ID=…         MICROSOFT_OAUTH_CLIENT_SECRET=…
# ZOOM_OAUTH_CLIENT_ID=…              ZOOM_OAUTH_CLIENT_SECRET=…
# OAUTH_STATE_SECRET=<openssl rand -hex 32>   (required if any of the above is set)
# LINKEDIN_CLIENT_ID=…  LINKEDIN_CLIENT_SECRET=…  LINKEDIN_SCOPES=…
# LINKEDIN_REDIRECT_URI=https://www.scouts.yavar.ai/api/public/linkedin/callback
# LINKEDIN_STATE_SECRET=<openssl rand -hex 32>
# GOOGLE_INDEXING_CREDENTIALS=<service-account JSON, raw or base64>
# GITHUB_TOKEN=…                       (raises GitHub public-profile limits)
# INTEGRATION_ALLOWED_HOSTS=…          (extra hosts integrations may call)
# CAPTURE_EXTENSION_IDS=…              (browser companion ids allowed to call capture APIs)

# --- agents (optional)
# AGENT_CONCURRENCY=6      (agent runs one scheduler tick drives at once, 1–20)
# AGENT_INLINE_KICK=1      (0 = only the scheduler drives runs)
```

`scouts-voice.env` (→ Secret Manager `scouts-voice`; omit the voice worker
entirely if phone screening is not used):

```dotenv
SIP_SERVER=sip.provider.example
SIP_PORT=5060
SIP_USER=…
SIP_PASSWORD=…
SIP_AUTH_USER=…           # if different from SIP_USER
SIP_DOMAIN=…              # if different from SIP_SERVER
SIP_CALLER_NAME=Scouts
SIP_PUBLIC_IP=<scouts-nat-ip>   # only if callers hear nothing (one-way audio)
VOICE_MAX_CONCURRENT=2
```

The AI voice itself uses each organisation's own key (Integrations → AI model);
the worker holds no AI key. Without `SIP_*` the worker exits with a clear log line.

---

## 6. First deployment by hand (do this once before turning on CI/CD)

```bash
TAG=$(git rev-parse --short HEAD)
IMG=$REGION-docker.pkg.dev/$PROJECT/$REPO/scouts
gcloud auth configure-docker $REGION-docker.pkg.dev --quiet
(cd extension && zip -qr ../public/atsiq-capture.zip manifest.json background.js popup.js popup.html portal-fill.js)
docker build -t $IMG:$TAG . && docker push $IMG:$TAG
docker build --target migrate -t $IMG-migrate:$TAG . && docker push $IMG-migrate:$TAG

kubectl apply -f infra/gke/00-namespace.yaml
# Secrets from Secret Manager
gcloud secrets versions access latest --secret scouts-env > /tmp/s.env
echo "PARSER_TOKEN=$(gcloud secrets versions access latest --secret scouts-parser-token)" >> /tmp/s.env
kubectl -n scouts create secret generic scouts-env --from-env-file /tmp/s.env --dry-run=client -o yaml | kubectl apply -f -
kubectl -n scouts create secret generic scouts-parser \
  --from-literal PARSER_TOKEN="$(gcloud secrets versions access latest --secret scouts-parser-token)" \
  --dry-run=client -o yaml | kubectl apply -f -
gcloud secrets versions access latest --secret scouts-voice > /tmp/v.env
kubectl -n scouts create secret generic scouts-voice --from-env-file /tmp/v.env --dry-run=client -o yaml | kubectl apply -f -
shred -u /tmp/s.env /tmp/v.env

# Migrations (inside the cluster: Cloud SQL is private)
sed -e "s#MIGRATE_IMAGE_PLACEHOLDER#$IMG-migrate:$TAG#" -e "s#RELEASE_PLACEHOLDER#$TAG#" \
  infra/gke/50-migrate-job.yaml | kubectl apply -f -
kubectl -n scouts wait --for=condition=complete job/scouts-migrate-$TAG --timeout=600s
kubectl -n scouts logs job/scouts-migrate-$TAG | tail -5

# Workloads
for f in 10-app 20-ingress 30-parser 40-voice-worker; do
  sed "s#IMAGE_PLACEHOLDER#$IMG:$TAG#" infra/gke/$f.yaml | kubectl apply -f -
done
kubectl -n scouts rollout status deploy/scouts-app --timeout=300s
kubectl -n scouts rollout status deploy/scouts-parser --timeout=300s
kubectl -n scouts get managedcertificate scouts-cert   # wait for Active
```

Smoke checks once the certificate is Active:

```bash
curl -sfI https://www.scouts.yavar.ai/ | head -1          # HTTP/2 200
curl -sfI http://www.scouts.yavar.ai/ | head -1           # 301 → https
curl -s -o /dev/null -w '%{http_code}\n' https://www.scouts.yavar.ai/privacy   # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.scouts.yavar.ai/api/public/agent-tick   # 401 without the secret
```

---

## 7. First organisation and platform admin

Run the bootstrap once, from a pod that can reach the database (the migrate
image has Bun, the scripts and node_modules):

```bash
kubectl -n scouts run bootstrap --rm -it --restart=Never \
  --image $IMG-migrate:$TAG \
  --env ORG_NAME="Yavar" --env OWNER_EMAIL="owner@yavar.ai" \
  --overrides '{"spec":{"containers":[{"name":"bootstrap","image":"'$IMG-migrate:$TAG'","command":["bun","scripts/bootstrap-org.ts"],"envFrom":[{"secretRef":{"name":"scouts-env"}}],"env":[{"name":"ORG_NAME","value":"Yavar"},{"name":"OWNER_EMAIL","value":"owner@yavar.ai"}]}]}}'
```

It creates the organisation, makes the owner the platform super admin, and
e-mails a one-time link (60 minutes) to set the password — `SMTP_URL` must work.
No password is ever set or seen by the operator. Idempotent.

**Moving existing data** (from the current `atsiq` database): run the migrations
first (§6), then `pg_restore --data-only --no-owner -d "$DATABASE_URL" atsiq.dump`
from a pod in the cluster, then compare row counts (`users`, `organizations`,
`candidates`, `requisitions`). Credentials stored by organisations are encrypted
with the old `SECRET_ENCRYPTION_KEY` — reuse the **same** key, or organisations
must re-enter their AI and integration keys.

---

## 8. Integrations that need the domain registered

Register these redirect URIs in each provider's console (only for features you
enable):

| Provider                                                                                                   | Redirect URI                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Google Calendar / Meet (`GOOGLE_CALENDAR_OAUTH_*`; `GOOGLE_OAUTH_*` if you use one Google client for both) | `https://www.scouts.yavar.ai/api/public/integrations/google/callback`                                     |
| Microsoft Teams                                                                                            | `https://www.scouts.yavar.ai/api/public/integrations/microsoft/callback`                                  |
| Zoom                                                                                                       | `https://www.scouts.yavar.ai/api/public/integrations/zoom/callback`                                       |
| LinkedIn                                                                                                   | `https://www.scouts.yavar.ai/api/public/linkedin/callback`                                                |
| Google for Jobs (Indexing API)                                                                             | The service account must be an **owner** of the `https://www.scouts.yavar.ai/` property in Search Console |

E-mail: SPF, DKIM and DMARC for the `EMAIL_FROM` domain at the SMTP provider.

---

## 9. Scheduled jobs (Cloud Scheduler)

Every route needs `Authorization: Bearer <CRON_SECRET>`. **The agent tick is
essential** — without it the hiring agents never advance.

| Job                                                                | URL (POST)                         | Schedule                   |
| ------------------------------------------------------------------ | ---------------------------------- | -------------------------- |
| **Agent scheduler** (all hiring agents, health checks, SLO alerts) | `/api/public/agent-tick`           | `* * * * *` (every minute) |
| Candidate e-mail outbox                                            | `/api/public/process-email-outbox` | `*/5 * * * *`              |
| Careers-inbox sync and scoring                                     | `/api/public/inbox-sync`           | `*/10 * * * *`             |
| Screening-kit preparation                                          | `/api/public/screening-prep`       | `*/5 * * * *`              |
| HRMS employee sync                                                 | `/api/public/sync-hrms`            | `*/15 * * * *`             |
| Job-board application sync                                         | `/api/public/board-sync`           | `*/15 * * * *`             |
| Candidate re-sync and scoring                                      | `/api/public/sync-candidates`      | `0 * * * *`                |

```bash
CRON_SECRET=$(gcloud secrets versions access latest --secret scouts-env | sed -n 's/^CRON_SECRET=//p')
add_job() { # name schedule path
  gcloud scheduler jobs create http "scouts-$1" --location $REGION --schedule "$2" \
    --time-zone "Asia/Kolkata" --http-method POST \
    --uri "https://www.scouts.yavar.ai$3" \
    --headers "Authorization=Bearer $CRON_SECRET,Content-Type=application/json" \
    --attempt-deadline 300s
}
add_job agent-tick       "* * * * *"    /api/public/agent-tick
add_job email-outbox     "*/5 * * * *"  /api/public/process-email-outbox
add_job inbox-sync       "*/10 * * * *" /api/public/inbox-sync
add_job screening-prep   "*/5 * * * *"  /api/public/screening-prep
add_job sync-hrms        "*/15 * * * *" /api/public/sync-hrms
add_job board-sync       "*/15 * * * *" /api/public/board-sync
add_job sync-candidates  "0 * * * *"    /api/public/sync-candidates
```

When `CRON_SECRET` is rotated: put the old value in `CRON_SECRET_PREVIOUS`,
deploy, update the jobs, then remove it.

---

## 10. CI/CD (GitHub Actions → GKE)

### 10.1 What the pipeline does

```
push to main ─► CI (.github/workflows/ci.yml): typecheck, lint, dependency audit,
                secrets scan, migrations on a test DB, test suites, agent-definition lock
            └─► Deploy (.github/workflows/deploy-gke.yml), after CI passes:
                 1. build the companion zip, the runtime image and the migrate image
                    (SBOM + provenance attached), push to Artifact Registry
                 2. sync Secret Manager → Kubernetes Secrets
                 3. run the migration Job; stop if it fails
                 4. roll out app, parser, voice worker by image digest
                 5. smoke checks; on failure roll the app back to the previous image
```

Production deploys pass through a GitHub **Environment** named `production` with
required reviewers, so every release is approved by a person.

### 10.2 Keyless auth from GitHub (Workload Identity Federation)

No service-account JSON keys:

```bash
gcloud iam service-accounts create scouts-deployer --display-name "Scouts deployer (GitHub Actions)"
SA=scouts-deployer@$PROJECT.iam.gserviceaccount.com
for role in roles/container.developer roles/artifactregistry.writer roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role $role
done
gcloud iam workload-identity-pools create github --location global --display-name GitHub
gcloud iam workload-identity-pools providers create-oidc github-actions \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository=='madhugraj/ATSAgent' && assertion.ref=='refs/heads/main'"
POOL=$(gcloud iam workload-identity-pools describe github --location global --format 'value(name)')
gcloud iam service-accounts add-iam-policy-binding $SA \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/$POOL/attribute.repository/madhugraj/ATSAgent"
gcloud iam workload-identity-pools providers describe github-actions \
  --location global --workload-identity-pool github --format 'value(name)'   # → GCP_WIF_PROVIDER
```

### 10.3 Repository settings

| Kind              | Name                 | Value                                                       |
| ----------------- | -------------------- | ----------------------------------------------------------- |
| Variable          | `GKE_DEPLOY_ENABLED` | `true` (the workflow is off until set)                      |
| Variable          | `GCP_PROJECT`        | `yavar-scouts-prod`                                         |
| Variable          | `GCP_REGION`         | `asia-south1`                                               |
| Variable          | `GKE_CLUSTER`        | `scouts`                                                    |
| Variable          | `GAR_REPOSITORY`     | `scouts`                                                    |
| Variable          | `GCP_WIF_PROVIDER`   | output of §10.2                                             |
| Variable          | `GCP_DEPLOY_SA`      | `scouts-deployer@yavar-scouts-prod.iam.gserviceaccount.com` |
| Environment       | `production`         | required reviewers: release owners                          |
| Branch protection | `main`               | require the **CI** check and one review                     |

Leave the older Cloud Run workflow (`deploy.yml`) **off** (`DEPLOY_ENABLED` unset)
so the two never deploy at once.

### 10.4 Reaching a private control plane

GitHub-hosted runners come from public IPs. Choose one:

- **Authorized networks** on the cluster for GitHub's published runner ranges (simple; ranges change), or
- **GKE DNS-based control-plane endpoint** (`--enable-dns-access` on the cluster; IAM-only, no IP lists) — recommended, or
- a **self-hosted runner** inside `scouts-vpc`.

### 10.5 Rollback

```bash
kubectl -n scouts rollout undo deploy/scouts-app
kubectl -n scouts rollout undo deploy/scouts-parser
kubectl -n scouts rollout undo deploy/scouts-voice-worker
```

Migrations are forward-only and written to be backward compatible (old code runs
on the new schema), so rolling back the image does not need a database rollback.

---

## 11. Operations

**Monitoring.** One JSON log line per request (`msg: "http.request"`, with
`trace_id`); search Logs Explorer by `jsonPayload.trace_id="<x-request-id>"`.
SLOs (server-function availability and latency, agent run success) are on
**Platform → Service health** in the app; dashboards and alert policies as code
are in `infra/monitoring/` — apply after the first deploy (see its README). With
`METRICS_TOKEN` set, `/metrics` serves OpenMetrics for Managed Prometheus.
Agent-level health (failures, budgets, stale approvals) is in the app under
**Agents → Observability**.

**Backups.** Cloud SQL automated backups + point-in-time recovery (§3.5); test a
restore quarterly. Object versioning on the bucket is recommended:
`gcloud storage buckets update gs://$BUCKET --versioning`.

**Scaling.** App: HPA 2–6 on CPU. Parser: one document at a time per request;
raise replicas for bulk CV imports. Voice worker: one replica handles
`VOICE_MAX_CONCURRENT` calls; add replicas for more simultaneous calls (calls are
claimed atomically). Agent throughput: `AGENT_CONCURRENCY`.

**Security checklist**

- The app must be reachable **only** through the load balancer (`TRUSTED_PROXY_COUNT=1`); no NodePort or public Service.
- Parser: NetworkPolicy deny-all egress stays applied; no secrets but `PARSER_TOKEN`.
- No platform AI keys; organisations bring their own (encrypted at rest).
- `SECRET_ENCRYPTION_KEY`: sealed offline backup; rotating it means re-encrypting stored credentials.
- Never run `drizzle-kit migrate`; only `scripts/migrate-pg.mjs`.
- Never commit `.env` files or `SECURITY_AUDIT_REPORT*.md` while the repository is public.

**Rough monthly cost (asia-south1, light production)**

| Item                                                                             | Estimate                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GKE Autopilot pods (app 2×0.5 vCPU/1 GiB, parser 2×0.5/1 GiB, voice 0.5/0.5 GiB) | ~$120–180                                                         |
| Cloud SQL 2 vCPU / 7.5 GB, HA, 50 GB                                             | ~$230–280                                                         |
| Load balancer + static IPs + Cloud NAT                                           | ~$40–60                                                           |
| Storage, Artifact Registry, Secret Manager, Scheduler, Logging                   | ~$20–40                                                           |
| **Total**                                                                        | **~$410–560** (AI usage is billed to each organisation's own key) |

---

## 12. Go-live checklist

1. [ ] DNS: `www.scouts.yavar.ai` and `scouts.yavar.ai` → `scouts-ip`; certificate **Active**.
2. [ ] Migration Job completed; `pg_migrations` lists every file in `drizzle/pg-migrations/`.
3. [ ] `https://www.scouts.yavar.ai/` 200; HTTP redirects to HTTPS.
4. [ ] Bootstrap e-mail received; owner set a password and signed in.
5. [ ] Upload a CV → parsed (parser reachable, bucket writes work).
6. [ ] Cloud Scheduler: `scouts-agent-tick` succeeding every minute (Scheduler logs show 200).
7. [ ] An agent switched on in Agent settings starts a run within a minute.
8. [ ] E-mail delivered (sign-up / password reset) with SPF/DKIM passing.
9. [ ] Phone screening (if used): SIP provider allow-listed the NAT IP; a test call connects with two-way audio.
10. [ ] Monitoring policies applied; on-call channel receives a test alert.
11. [ ] CI/CD: a merge to `main` runs CI, waits for approval, deploys, smoke-checks.
