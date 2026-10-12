/**
 * Export an organisation's training data as JSONL (docs/agentic-plan.md §14).
 *
 *   bun scripts/training-export.ts --org <orgId> --out <dir> [--since YYYY-MM-DD]
 *
 * Writes sft.jsonl, preferences.jsonl, trajectories.jsonl, feedback.jsonl,
 * evals.jsonl and manifest.json. Refuses organisations that have not agreed to
 * capture. Personal data is pseudonymised: the organisation's candidates' and
 * members' names, emails and phone numbers become stable tokens, and any other
 * email address or phone number is masked. Free-text pseudonymisation is best
 * effort — review a sample before any data leaves your environment. Every
 * export is written to the audit log.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { writeAudit } = await import("../src/server/audit");

const { values: args } = parseArgs({
  options: {
    org: { type: "string" },
    out: { type: "string" },
    since: { type: "string" },
  },
});
if (!args.org || !args.out) {
  console.error(
    "Usage: bun scripts/training-export.ts --org <orgId> --out <dir> [--since YYYY-MM-DD]",
  );
  process.exit(1);
}
const orgId = args.org;
const since = args.since ? new Date(`${args.since}T00:00:00Z`) : new Date(0);
const q = async <T>(query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as T[];

/* ------------------------------------------------------------ consent */

const [consent] = await q<{ enabled: boolean; consented_at: string | null }>(
  sql`select enabled, consented_at from training_settings where org_id = ${orgId}`,
);
if (!consent?.enabled) {
  console.error("This organisation has not agreed to training-data capture; nothing exported.");
  process.exit(2);
}

/* ------------------------------------------------------------ pseudonymisation */

const people = [
  ...(
    await q<{ name: string | null; email: string | null; phone: string | null }>(
      sql`select full_name as name, email, phone from candidates where org_id = ${orgId}`,
    )
  ).map((p) => ({ ...p, kind: "candidate" })),
  ...(
    await q<{ name: string | null; email: string | null }>(
      sql`select full_name as name, email from org_members where org_id = ${orgId}`,
    )
  ).map((p) => ({ ...p, phone: null, kind: "member" })),
];
const { buildPseudonymiser } = await import("../src/server/training/pseudonymise");
const scrub = buildPseudonymiser(orgId, people);

/* ------------------------------------------------------------ read */

type Inf = {
  id: string;
  call_kind: string;
  feature: string;
  provider: string;
  model: string;
  request: Record<string, unknown>;
  response: unknown;
  status: string;
  stop_reason: string | null;
  agent_run_id: string | null;
  application_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number | null;
  request_hash: string;
  created_at: string;
};
const inferences = await q<Inf>(sql`
  select id, call_kind, feature, provider, model, request, response, status, stop_reason,
    agent_run_id, application_id, prompt_tokens, completion_tokens, latency_ms, request_hash, created_at
  from training_inferences where org_id = ${orgId} and created_at >= ${since.toISOString()}::timestamptz
  order by created_at`);
type Fb = {
  id: string;
  source: string;
  label: string;
  rating: number | null;
  reason: string | null;
  original: unknown;
  corrected: unknown;
  inference_id: string | null;
  agent_run_id: string | null;
  agent_task_id: string | null;
  application_id: string | null;
  actor_kind: string;
  created_at: string;
};
const feedback = await q<Fb>(sql`
  select id, source, label, rating, reason, original, corrected, inference_id, agent_run_id,
    agent_task_id, application_id, actor_kind, created_at
  from training_feedback where org_id = ${orgId} and created_at >= ${since.toISOString()}::timestamptz
  order by created_at`);
const outcomes = new Map(
  feedback
    .filter((f) => f.source === "outcome" && f.application_id)
    .map((f) => [f.application_id!, f.label]),
);
const byInference = new Map<string, Fb[]>();
for (const f of feedback)
  if (f.inference_id)
    byInference.set(f.inference_id, [...(byInference.get(f.inference_id) ?? []), f]);
const NEGATIVE = new Set(["rejected", "changes_requested", "bad", "unsafe", "off_policy"]);

/* ------------------------------------------------------------ write */

mkdirSync(args.out, { recursive: true });
const write = (name: string, rows: unknown[]) => {
  writeFileSync(
    path.join(args.out!, name),
    rows.map((r) => JSON.stringify(scrub(r))).join("\n") + (rows.length ? "\n" : ""),
  );
  return rows.length;
};

// SFT: model calls that worked and that no person judged negatively.
const sft = inferences
  .filter(
    (i) => i.status === "ok" && !(byInference.get(i.id) ?? []).some((f) => NEGATIVE.has(f.label)),
  )
  .map((i) => ({
    id: i.id,
    kind: i.call_kind,
    feature: i.feature,
    request: i.request,
    response: i.response,
    judgements: (byInference.get(i.id) ?? []).map((f) => ({
      source: f.source,
      label: f.label,
      rating: f.rating,
    })),
    outcome: i.application_id ? (outcomes.get(i.application_id) ?? null) : null,
    teacher: { provider: i.provider, model: i.model },
  }));

// Preferences: what the model proposed vs what a person said it should be.
const preferences = feedback
  .filter(
    (f) =>
      f.inference_id && f.corrected != null && (f.label === "edited" || f.source === "annotation"),
  )
  .map((f) => {
    const inf = inferences.find((i) => i.id === f.inference_id);
    return inf
      ? {
          inference_id: inf.id,
          feature: inf.feature,
          request: inf.request,
          rejected: f.original ?? inf.response,
          chosen: f.corrected,
          source: f.source,
          reason: f.reason,
        }
      : null;
  })
  .filter(Boolean);

// Trajectories: whole agent runs with their decisions and the final outcome.
const runs = await q<{
  id: string;
  agent_type: string;
  definition_version: string | null;
  definition_hash: string | null;
  goal: string;
  status: string;
  result: string | null;
  subject_type: string | null;
  subject_id: string | null;
  mode: string;
}>(sql`
  select id, agent_type, definition_version, definition_hash, goal, status, result, subject_type, subject_id, mode
  from agent_runs where org_id = ${orgId} and created_at >= ${since.toISOString()}::timestamptz
    and id in (select distinct agent_run_id from training_inferences where org_id = ${orgId} and agent_run_id is not null)
  order by created_at`);
const steps = await q<{
  run_id: string;
  seq: number;
  kind: string;
  tool_name: string | null;
  status: string;
  input: unknown;
  output: unknown;
}>(sql`
  select run_id, seq, kind, tool_name, status, input, output from agent_steps
  where org_id = ${orgId} and run_id in (select distinct agent_run_id from training_inferences where org_id = ${orgId} and agent_run_id is not null)
  order by run_id, seq`);
const trajectories = runs.map((r) => ({
  run_id: r.id,
  agent: { type: r.agent_type, version: r.definition_version, definition_hash: r.definition_hash },
  mode: r.mode,
  goal: r.goal,
  turns: inferences
    .filter((i) => i.agent_run_id === r.id)
    .map((i) => ({
      id: i.id,
      request: i.request,
      response: i.response,
      stop_reason: i.stop_reason,
    })),
  steps: steps.filter((s) => s.run_id === r.id),
  decisions: feedback
    .filter((f) => f.agent_run_id === r.id)
    .map((f) => ({ source: f.source, label: f.label, reason: f.reason, corrected: f.corrected })),
  status: r.status,
  result: r.result,
  outcome:
    r.subject_type === "application" && r.subject_id ? (outcomes.get(r.subject_id) ?? null) : null,
}));

const evals = await q<Record<string, unknown>>(sql`
  select scenario, agent_type, agent_version, definition_hash, mode, passed, checks, tokens, created_at
  from training_eval_results where created_at >= ${since.toISOString()}::timestamptz order by created_at`);

const counts = {
  sft: write("sft.jsonl", sft),
  preferences: write("preferences.jsonl", preferences),
  trajectories: write("trajectories.jsonl", trajectories),
  feedback: write("feedback.jsonl", feedback),
  evals: write("evals.jsonl", evals),
};
const manifest = {
  schema: "atsiq-training/1",
  orgId,
  generatedAt: new Date().toISOString(),
  since: since.toISOString(),
  consentGivenAt: consent.consented_at,
  pseudonymised: true,
  pseudonymisation:
    "Names, emails and phones of the organisation's candidates and members replaced with stable tokens; other emails and phone numbers masked. Free text is best effort — review a sample.",
  counts,
};
writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeAudit({
  actor: "platform:training-export",
  orgId,
  action: "training.exported",
  entityType: "training_settings",
  entityId: orgId,
  detail: { ...counts, since: manifest.since },
});
console.log(JSON.stringify(manifest, null, 2));
process.exit(0);
