#!/usr/bin/env bash
# One-time setup for the sandboxed document parser (docs/guardrails.md P2-1).
# Idempotent: safe to re-run. Needs gcloud signed in as a project owner.
#
#   GCP_PROJECT=my-project GCP_REGION=asia-south1 \
#   DEPLOY_SA=deployer@my-project.iam.gserviceaccount.com \
#   bash infra/network/parser-sandbox.sh
#
# What it builds:
#   - VPC `atsiq-sandbox` with one small subnet and NO Cloud Router / NAT, plus
#     a deny-all egress firewall: anything running in it has no route out.
#   - Service account `atsiq-parser` with no roles (no secrets except its own
#     token, no database, no buckets).
#   - Secret `atsiq-parser-token` (a random shared token, the second check
#     after Cloud Run IAM), readable by the app and the parser.
#   - Lets the deploy service account deploy services that run as atsiq-parser.
# After the first deploy with PARSER_ENABLED=true, it also grants the app's
# runtime service account roles/run.invoker on atsiq-parser (re-run it then).
set -euo pipefail
PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:?set GCP_REGION}"
DEPLOY_SA="${DEPLOY_SA:?set DEPLOY_SA (the GitHub deploy service account)}"
NET=atsiq-sandbox
SUBNET=atsiq-parser
RANGE="${PARSER_SUBNET_RANGE:-10.90.0.0/26}"
PARSER_SA="atsiq-parser@${PROJECT}.iam.gserviceaccount.com"
g() { gcloud --project "$PROJECT" --quiet "$@"; }

echo "→ network ${NET} (no NAT, no router)"
g compute networks describe "$NET" >/dev/null 2>&1 ||
  g compute networks create "$NET" --subnet-mode=custom
g compute networks subnets describe "$SUBNET" --region "$REGION" >/dev/null 2>&1 ||
  g compute networks subnets create "$SUBNET" --network "$NET" --region "$REGION" \
    --range "$RANGE" --no-enable-private-ip-google-access

echo "→ firewall: deny all egress, deny all ingress"
g compute firewall-rules describe atsiq-sandbox-deny-egress >/dev/null 2>&1 ||
  g compute firewall-rules create atsiq-sandbox-deny-egress --network "$NET" \
    --direction EGRESS --action DENY --rules all --destination-ranges 0.0.0.0/0 --priority 100
g compute firewall-rules describe atsiq-sandbox-deny-ingress >/dev/null 2>&1 ||
  g compute firewall-rules create atsiq-sandbox-deny-ingress --network "$NET" \
    --direction INGRESS --action DENY --rules all --source-ranges 0.0.0.0/0 --priority 100

echo "→ service account atsiq-parser (no roles)"
g iam service-accounts describe "$PARSER_SA" >/dev/null 2>&1 ||
  g iam service-accounts create atsiq-parser --display-name "ATSIQ document parser (sandbox)"
g iam service-accounts add-iam-policy-binding "$PARSER_SA" \
  --member "serviceAccount:${DEPLOY_SA}" --role roles/iam.serviceAccountUser >/dev/null

echo "→ secret atsiq-parser-token"
if ! g secrets describe atsiq-parser-token >/dev/null 2>&1; then
  head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | g secrets create atsiq-parser-token --data-file=-
fi
APP_SA="$(g run services describe atsiq --region "$REGION" \
  --format 'value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
APP_SA="${APP_SA:-$(g projects describe "$PROJECT" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com}"
for sa in "$PARSER_SA" "$APP_SA"; do
  g secrets add-iam-policy-binding atsiq-parser-token \
    --member "serviceAccount:${sa}" --role roles/secretmanager.secretAccessor >/dev/null
done

if g run services describe atsiq-parser --region "$REGION" >/dev/null 2>&1; then
  echo "→ only the app (${APP_SA}) may call atsiq-parser"
  g run services add-iam-policy-binding atsiq-parser --region "$REGION" \
    --member "serviceAccount:${APP_SA}" --role roles/run.invoker >/dev/null
else
  echo "→ atsiq-parser is not deployed yet: set the repo variable PARSER_ENABLED=true and deploy (the workflow grants the app run.invoker)."
fi
echo "done."
