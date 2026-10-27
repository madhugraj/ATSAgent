# ATSIQ — Cloud Monitoring as code

Dashboards and alert policies for the GKE deployment. The SLO targets they
encode live in `src/server/slo.ts`; keep the numbers here in step with it.

| File                                                   | What it creates                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log-metrics.sh`                                       | Log-based metrics from the app's `http.request` and `slo.burn_alert` JSON log lines: `atsiq_http_requests` (counter: `route_group`, `method`, `status_class`), `atsiq_http_request_latency` (distribution, ms, by `route_group`), `atsiq_slo_burn_alerts` (`slo`, `severity`), `atsiq_agent_ticks` |
| `dashboard.json`                                       | "ATSIQ — service health": request rate, server-function 5xx ratio vs the 1 % budget, p95 latency by route group, status classes, app burn alerts, container CPU/memory, Cloud SQL CPU/connections                                                                                                  |
| `alert-policies/server-fn-availability-fast-burn.json` | Page: 5xx ratio ≥ 14.4 × budget over 1 h **and** 5 min                                                                                                                                                                                                                                             |
| `alert-policies/server-fn-availability-slow-burn.json` | Ticket: ≥ 6 × budget over 6 h **and** 30 min                                                                                                                                                                                                                                                       |
| `alert-policies/server-fn-latency.json`                | Server-function p95 > 2.5 s for 15 min                                                                                                                                                                                                                                                             |
| `alert-policies/app-slo-burn-alert.json`               | Log-match on `slo.burn_alert` — the app's own evaluator, which also covers agent run success                                                                                                                                                                                                       |
| `alert-policies/scheduler-stalled.json`                | No `/api/public/agent-tick` call for 10 min (agents, health rules and SLO alerts stop without it)                                                                                                                                                                                                  |
| `podmonitoring.yaml`                                   | Optional Managed Prometheus scrape of `/metrics` (bearer `METRICS_TOKEN`)                                                                                                                                                                                                                          |

## Apply

```bash
export PROJECT=your-project
# 1. Log-based metrics (idempotent)
./infra/monitoring/log-metrics.sh

# 2. Dashboard
gcloud monitoring dashboards create --project "$PROJECT" \
  --config-from-file infra/monitoring/dashboard.json

# 3. A notification channel (e-mail shown; Slack / PagerDuty / webhook work the same)
gcloud beta monitoring channels create --project "$PROJECT" \
  --display-name "ATSIQ on-call" --type email \
  --channel-labels email_address=oncall@example.com
CHANNEL=$(gcloud beta monitoring channels list --project "$PROJECT" \
  --filter 'displayName="ATSIQ on-call"' --format 'value(name)')

# 4. Alert policies, each wired to that channel
for f in infra/monitoring/alert-policies/*.json; do
  gcloud alpha monitoring policies create --project "$PROJECT" \
    --policy-from-file "$f" --notification-channels "$CHANNEL"
done

# 5. Uptime check on the public site (readiness is GET /)
gcloud monitoring uptime create atsiq-home --project "$PROJECT" \
  --resource-type uptime-url --resource-labels host=atsiq.yavar.ai,project_id="$PROJECT" \
  --path / --protocol https --period 1
```

Log-based metrics only count lines written after they exist, so the dashboard
fills from the moment step 1 runs. The container name filter is `atsiq`
(DEPLOYMENT-GCP.md §7); change it in `log-metrics.sh` and
`app-slo-burn-alert.json` if yours differs.

## Label rules (cardinality)

Metric labels come from a fixed set only: `route_group` (server_fn, page,
api_public, api_auth, api, metrics, static), `method` (GET, HEAD, POST, PUT,
PATCH, DELETE, OPTIONS, OTHER), `status_class` (1xx–5xx), and for burn alerts
`slo` / `severity`. Never add `http_route`, `server_fn`, `trace_id`, org, user,
candidate, token or model fields as labels — they stay in the log line, where
you filter by them instead.

## Finding one request

Every response carries `x-request-id` (and `traceparent`). In Logs Explorer:

```
jsonPayload.trace_id="<x-request-id>"
```

returns every log line of that request — server functions, AI gateway calls,
agent run lines when the request started a run — and the run itself is the
`agent_runs` row whose `trace_id` (as a uuid) is the same id. With
`GOOGLE_CLOUD_PROJECT` set, lines also carry `logging.googleapis.com/trace`, so
Logs Explorer groups them under the trace.
