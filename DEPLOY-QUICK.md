# ATSIQ — quick self-service deploy

One command takes `main` to production. No DevOps, no Docker, no Cloud Build needed.

```bash
scripts/deploy.sh          # deploy current HEAD
scripts/deploy.sh <sha>    # deploy a specific commit
```

**Prerequisites (one-time, already set up on this machine):** `gcloud` + `kubectl` logged in as
**`madhu.r@yavar.ai`** (this account holds the cluster RBAC and the Artifact Registry write — never
use the gmail account). The first `kubectl` call may need
`gcloud container clusters get-credentials yavar-studio-cluster --region asia-south1 --project yavar-studio`.

## What the script does

1. Packs the **committed** tree (`git archive`) plus the freshly-rebuilt Capture companion zip.
2. Builds the app in a throwaway `oven/bun` pod inside the cluster (`bun install && bun run build`).
3. Pushes the runtime image with **kaniko** (another throwaway pod) to
   `asia-south1-docker.pkg.dev/yavar-studio/yavar-platform/atsiq:<sha>`.
4. Rolls `deployment/atsiq` and runs smoke checks. On a failed rollout it **rolls back automatically**.

Takes ~5 minutes. Throwaway pods clean themselves up.

## Migrations (only when `drizzle/pg-migrations/` gained new files)

```bash
scripts/deploy.sh migrate          # runs the idempotent migrate-pg runner against prod DB
```

The runner records applied files in `pg_migrations` and is safe to re-run. Run `migrate` **after**
deploying the image (it uses the repo at the deployed commit). Never use `drizzle-kit migrate`.

## Verify a release

- App answers `https://z-atsiq.yavar.ai/` with 200 (the script does this).
- Integrations → each connector's card shows the expected state; requisition pages render.
- CronJobs `atsiq-board-sync` / `atsiq-sync-hrms` pods complete every 15 min (`kubectl -n atsiq get cronjobs`).

## Rollback

```bash
kubectl -n atsiq set image deploy/atsiq atsiq=asia-south1-docker.pkg.dev/yavar-studio/yavar-platform/atsiq:<previous-sha>
kubectl -n atsiq rollout status deploy/atsiq
```

(The script prints the previous image before every rollout. Migrations are additive/idempotent —
a rollback never needs a reverse migration.)

## When it breaks

| Symptom                                        | Fix                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAIL: gcloud account is not madhu.r@yavar.ai` | `gcloud auth list` — set the active account.                                                                                                                                  |
| kaniko build killed (exit 137)                 | Build context too heavy — the script already avoids this by building the app in the bun pod and letting kaniko see only `.output`. If you edited the script, keep that split. |
| `kubectl cp` truncates a file                  | The script verifies byte sizes and retries — if it still fails, just re-run.                                                                                                  |
| Docker/`gcloud builds` issues                  | Irrelevant by design — this path uses neither.                                                                                                                                |

Full infrastructure reference (provisioning, DNS/TLS, secrets, scheduler): `DEPLOYMENT-GCP.md` and
`infra/DEPLOYMENT-HANDOFF.md`. Deploy history: image tags are commit shas —
`kubectl -n atsiq get deploy atsiq -o jsonpath='{.spec.template.spec.containers[0].image}'`.
