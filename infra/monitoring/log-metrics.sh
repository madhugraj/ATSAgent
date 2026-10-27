#!/usr/bin/env bash
# Log-based metrics for ATSIQ request telemetry (README → Observability).
# Source: the one `http.request` JSON log line per request written by
# src/server.ts. Labels are the fixed, low-cardinality set only:
# route_group, method, status_class — never http_route, server_fn, trace_id,
# org or user ids. Idempotent: re-running updates the definitions.
# Usage: PROJECT=my-project ./infra/monitoring/log-metrics.sh
set -euo pipefail
: "${PROJECT:?set PROJECT}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FILTER='resource.type="k8s_container" AND resource.labels.container_name="atsiq" AND jsonPayload.msg="http.request"'

cat >"$TMP/requests.yaml" <<YAML
name: atsiq_http_requests
description: ATSIQ HTTP requests by route group, method and status class.
filter: '$FILTER'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: route_group
    - key: method
    - key: status_class
labelExtractors:
  route_group: EXTRACT(jsonPayload.route_group)
  method: EXTRACT(jsonPayload.http_method)
  status_class: EXTRACT(jsonPayload.status_class)
YAML

cat >"$TMP/latency.yaml" <<YAML
name: atsiq_http_request_latency
description: ATSIQ HTTP request duration (ms, to response headers) by route group.
filter: '$FILTER'
valueExtractor: EXTRACT(jsonPayload.duration_ms)
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: ms
  labels:
    - key: route_group
labelExtractors:
  route_group: EXTRACT(jsonPayload.route_group)
bucketOptions:
  explicitBuckets:
    bounds: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
YAML

cat >"$TMP/burn.yaml" <<YAML
name: atsiq_slo_burn_alerts
description: SLO burn-rate alerts raised by the app (src/server/slo.server.ts).
filter: 'resource.type="k8s_container" AND resource.labels.container_name="atsiq" AND jsonPayload.msg="slo.burn_alert"'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: slo
    - key: severity
labelExtractors:
  slo: EXTRACT(jsonPayload.slo)
  severity: EXTRACT(jsonPayload.severity)
YAML

cat >"$TMP/ticks.yaml" <<YAML
name: atsiq_agent_ticks
description: Scheduler calls of /api/public/agent-tick (drives agents, health rules and SLO burn alerts).
filter: '$FILTER AND jsonPayload.http_route="/api/public/agent-tick"'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
YAML

for m in requests latency burn ticks; do
  name="$(awk '/^name:/{print $2}' "$TMP/$m.yaml")"
  if gcloud logging metrics describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud logging metrics update "$name" --project "$PROJECT" --config-from-file "$TMP/$m.yaml"
  else
    gcloud logging metrics create "$name" --project "$PROJECT" --config-from-file "$TMP/$m.yaml"
  fi
done
echo "Log-based metrics ready. Next: dashboard and alert policies — see $DIR/README.md"
