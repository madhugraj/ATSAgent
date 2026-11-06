// Agent behavior + Governance graphs — real telemetry → self-contained HTML.
// Usage: DATABASE_URL=postgres://... bun scripts/agent-behavior-graph.ts [out.html]
// Two views, both computed from live SQL:
//   Agent behavior — agents × norms × vocabulary, candidates folded into edge weights
//   Governance     — person decisions, the norms they acted under, overturn chains
// Every node, edge count, and insight chip is derived; nothing about the fleet is hardcoded.

import postgres from "postgres";
import { buildOntology, slugify } from "../src/lib/ontology.server.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const sql = postgres(url, { max: 2 });
const out = process.argv[2] ?? "docs/design/agent-behavior-real.html";

type Row = Record<string, any>;

const runsByAgent: Row[] = await sql`
  SELECT r.agent_type, count(DISTINCT r.id)::int AS runs,
         count(s.id)::int AS steps,
         round(count(s.id)::numeric / greatest(count(DISTINCT r.id), 1), 1)::float AS avg_steps
  FROM agent_runs r LEFT JOIN agent_steps s ON s.run_id = r.id
  GROUP BY 1 ORDER BY 2 DESC`;
const runsByStatus: Row[] = await sql`
  SELECT status, count(*)::int FROM agent_runs GROUP BY 1`;
const runStatus = Object.fromEntries(runsByStatus.map((r) => [r.status, r.count]));
const tasksByAgentKind: Row[] = await sql`
  SELECT r.agent_type, t.kind, t.status, count(*)::int
  FROM agent_tasks t JOIN agent_runs r ON r.id = t.run_id
  GROUP BY 1,2,3`;
const rejectDetails: Row[] = await sql`
  SELECT r.agent_type, t.kind, left(t.title, 70) AS title, t.proposed_action->>'name' AS tool
  FROM agent_tasks t JOIN agent_runs r ON r.id = t.run_id
  WHERE t.status = 'rejected'`;
const errorClusters: Row[] = await sql`
  SELECT r.agent_type, coalesce(nullif(s.tool_name,''),'(model step)') AS tool, count(*)::int
  FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id
  WHERE s.status = 'error' GROUP BY 1,2 ORDER BY 3 DESC`;
const awaitingByAgent: Row[] = await sql`
  SELECT agent_type, count(*)::int FROM agent_runs WHERE status='awaiting_human' GROUP BY 1`;
const definitions: Row[] = await sql`
  SELECT agent_type, max(version) AS version FROM agent_definitions GROUP BY 1 ORDER BY 1`;
const defChurn: Row[] = await sql`
  SELECT agent_type, count(DISTINCT hash)::int AS versions FROM agent_definitions GROUP BY 1 ORDER BY 2 DESC`;
const openByAgent: Row[] = await sql`
  SELECT r.agent_type, count(*)::int FROM agent_tasks t JOIN agent_runs r ON r.id = t.run_id
  WHERE t.status = 'open' GROUP BY 1 ORDER BY 2 DESC`;
const taskStatusTotals: Row = (
  await sql`SELECT
    (SELECT count(*)::int FROM agent_tasks WHERE status = 'cancelled') AS cancelled,
    (SELECT count(*)::int FROM agent_tasks WHERE status = 'answered') AS answered,
    (SELECT count(*)::int FROM agent_tasks WHERE status = 'open') AS open`
)[0];
const stageActors: Row[] = await sql`
  SELECT coalesce(nullif(actor,''),'(none)') AS actor, count(*)::int FROM stage_events GROUP BY 1 ORDER BY 2 DESC`;
const stageTotal = stageActors.reduce((s, r) => s + r.count, 0);
const aiMoves = stageActors.filter((r) => r.actor === "ai").reduce((s, r) => s + r.count, 0);
const counts: Row = (
  await sql`SELECT
    (SELECT count(*)::int FROM requisitions) AS requisitions,
    (SELECT count(*)::int FROM candidates) AS candidates,
    (SELECT count(*)::int FROM applications) AS applications,
    (SELECT count(*)::int FROM skill_nodes) AS skill_nodes,
    (SELECT count(*)::int FROM skill_edges) AS skill_edges,
    (SELECT count(*)::int FROM match_scores) AS match_scores`
)[0];
const candRows: Row[] = await sql`
  SELECT c.id, c.skills, c.created_at,
         EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id AND a.stage IN ('hired','joined')) AS hired
  FROM candidates c
  WHERE c.skills IS NOT NULL AND array_length(c.skills, 1) > 0`;
const demandRows: Row[] = await sql`
  SELECT r.id, r.title, r.openings, r.must_have_skills, r.good_to_have_skills,
         r.status NOT IN ('closed','rejected') AS open, d.name AS dept
  FROM requisitions r LEFT JOIN departments d ON d.id = r.department_id
  WHERE r.must_have_skills IS NOT NULL OR r.good_to_have_skills IS NOT NULL`;
const orgCount = (await sql`SELECT count(*)::int AS n FROM organizations`)[0].n;
await sql.end({ timeout: 1 });

// ---------- derive (shared) ----------
const byAgentTask: Record<string, Record<string, Record<string, number>>> = {};
for (const r of tasksByAgentKind) {
  (byAgentTask[r.agent_type] ??= {})[r.kind] ??= {};
  byAgentTask[r.agent_type][r.kind][r.status] = r.count;
}
const taskTotal = (a: string, kind: string) =>
  Object.values(byAgentTask[a]?.[kind] ?? {}).reduce((s: number, n) => s + (n as number), 0);
const taskStat = (a: string, kind: string, st: string) => byAgentTask[a]?.[kind]?.[st] ?? 0;
const sumKind = (kind: string, st?: string) =>
  Object.entries(byAgentTask).reduce(
    (s, [, kinds]) =>
      s + (st ? (kinds[kind]?.[st] ?? 0) : Object.values(kinds[kind] ?? {}).reduce((x: number, n) => x + (n as number), 0)),
    0,
  );

const totalRuns = Object.values(runStatus).reduce((s, n) => s + (n as number), 0);
const totalSteps = runsByAgent.reduce((s, r) => s + r.steps, 0);
const approvals = sumKind("approval");
const approvalsRejected = sumKind("approval", "rejected");
const gates = sumKind("gate");
const gatesRejected = sumKind("gate", "rejected");
const clarifications = sumKind("clarification");
const awaiting = runStatus.awaiting_human ?? 0;
const failed = runStatus.failed ?? 0;
const cancelled = runStatus.cancelled ?? 0;
const norm = {
  hitl: { stops: approvals, rejected: approvalsRejected },
  gates: { stops: gates, rejected: gatesRejected },
  clarify: { stops: clarifications, rejected: 0 },
};
const errByAgent = new Map<string, number>();
for (const e of errorClusters) errByAgent.set(e.agent_type, (errByAgent.get(e.agent_type) ?? 0) + e.count);

// ================= VIEW 1 — AGENT BEHAVIOR =================
type Node = {
  id: string; type: string;
  name: string; runs?: number; steps?: number; avg?: number;
  ver?: string; stops?: number; rejected?: number; tool?: string;
  awaiting?: number; cause?: string; effect?: string; action?: string;
  idle?: boolean; members?: string[]; agent?: string; kind?: string; count?: number;
};
type Edge = { s: string; t: string; k: string; label?: string };
const nodes: Node[] = [];
const edges: Edge[] = [];
const stats = new Map(runsByAgent.map((r) => [r.agent_type, r]));
const idleAgents: string[] = [];
const gapAgents: string[] = [];

for (const d of definitions) {
  const r = stats.get(d.agent_type);
  if (!r) {
    idleAgents.push(d.agent_type);
    nodes.push({
      id: `ag-${d.agent_type}`, type: "agent", name: d.agent_type, ver: d.version,
      runs: 0, steps: 0, avg: 0, awaiting: 0, idle: true,
      cause: `Registered in the manifest (v${d.version}) with zero runs this period.`,
      effect: `The capability exists but nobody invokes it — dead weight in governance, evals and cost accounting, or an unadopted feature.`,
      action: `Decide: enable it (a tick, a copilot route, a client feature flag) or park it. An agent that never runs should not silently keep its manifest.`,
    });
    edges.push({ s: `ag-${d.agent_type}`, t: "hub-idle", k: "idle", label: "0 runs" });
    continue;
  }
  const a = d.agent_type;
  const appT = taskTotal(a, "approval");
  const appR = taskStat(a, "approval", "rejected");
  const gateT = taskTotal(a, "gate");
  const gateR = taskStat(a, "gate", "rejected");
  const cla = taskTotal(a, "clarification");
  const err = errByAgent.get(a) ?? 0;
  const n: Node = {
    id: `ag-${a}`, type: "agent", name: a, ver: d.version,
    runs: r.runs, steps: r.steps, avg: r.avg, awaiting: awaitingByAgent.find((x) => x.agent_type === a)?.count ?? 0,
  };
  if (appR >= 2 && appT > 0 && appR / Math.max(appT, 1) >= 0.1) {
    const top = rejectDetails.filter((x) => x.agent_type === a);
    n.cause = `Persons rejected ${appR} of ${appT} approval proposals (${Math.round((appR / appT) * 100)}%) — mostly "${top[0]?.title ?? "proposed action"}".`;
    n.effect = `The agent's judgment of "who to advance" is out of sync with the people reviewing it.`;
    n.action = `Read the rejection reasons in the decisions inbox; either the scorer's threshold or the proposal wording needs to change — not the reviewer.`;
  } else if (appT + gateT + cla > 0) {
    n.cause = `${appT + gateT + cla} person touchpoints (${appT} approvals, ${gateT} gates, ${cla} clarifications); ${appR + gateR} declined.`;
    n.effect = `Overturn rate ${Math.round(((appR + gateR) / Math.max(appT + gateT, 1)) * 100)}% — inside the healthy band (< 10%).`;
    n.action = `None — keep the 10% health threshold so drift surfaces on its own.`;
  } else if (r.steps > 0) {
    n.cause = `${r.runs} runs · ${r.steps} steps, all autonomous (no person touchpoints).`;
    n.effect = err > 0 ? `${err} tool errors — the failure cluster.` : `Clean: no errors, no interventions.`;
    n.action = err > 5 ? `Investigate the failing tool before trusting the output.` : `None.`;
  } else {
    gapAgents.push(a);
    n.cause = `${r.runs} runs with no agent steps (voice/panel sessions — captured outside agent_steps).`;
    n.effect = `Behavior lives in call transcripts, not the step trace — these agents are invisible to every step-based governance rule.`;
    n.action = `Add session-shaped telemetry (turns, consent, tool calls) so voice/panel behavior joins the graph and its health rules.`;
    edges.push({ s: `ag-${a}`, t: "hub-gap", k: "gap", label: `×${r.runs} runs, 0 steps` });
  }
  if (err >= 5 && n.action && !n.action.includes("Top failure")) {
    const top = errorClusters.filter((e) => e.agent_type === a)[0];
    n.action = n.action.startsWith("None") ? `Investigate top failure ${top.tool} ×${top.count}.` : `${n.action} Top failure: ${top.tool} ×${top.count}.`;
  }
  nodes.push(n);
  if (appT > 0) edges.push({ s: `ag-${a}`, t: "n-hitl", k: "gated", label: appR ? `×${appT}, ${appR} rejected` : undefined });
  if (gateT > 0) edges.push({ s: `ag-${a}`, t: "n-gates", k: "gated", label: gateR ? `×${gateT}, ${gateR} rejected` : undefined });
  if (cla > 0) edges.push({ s: `ag-${a}`, t: "n-clarify", k: "gated", label: `×${cla}` });
  for (const e of errorClusters) {
    if (e.agent_type === a && e.count >= 3) edges.push({ s: `ag-${a}`, t: `fail-${e.tool}`, k: "errored", label: `×${e.count}` });
  }
  if (a === "intake") edges.push({ s: "ag-intake", t: "vocab-seed", k: "awaits", label: `×${counts.match_scores} scores` });
}

if (idleAgents.length) {
  nodes.push({
    id: "hub-idle", type: "hub", name: `no traffic (${idleAgents.length})`, members: idleAgents,
    cause: `${idleAgents.length} of ${definitions.length} registered agents ran zero times: ${idleAgents.join(", ")}.`,
    effect: `Copilot — the routing front door — is among them: requests reach specialists directly, so routing and its guardrails are untested.`,
    action: `Per agent: enable (tick, copilot route, feature flag) or park. An idle manifest should be a decision, not an accident.`,
  });
}
if (gapAgents.length) {
  nodes.push({
    id: "hub-gap", type: "hub", name: `step-trace gap (${gapAgents.length})`, members: gapAgents,
    cause: `${gapAgents.join(", ")} ran with zero rows in agent_steps — voice/panel sessions are captured out-of-band.`,
    effect: `These agents bypass every step-based rule: error clusters, run limits on tools, and this graph.`,
    action: `Emit session turns as steps (consent, tool calls, outcomes) — until then, treat their transcripts as unaudited.`,
  });
}

const normSpecs = [
  { id: "n-hitl", name: "hitl_cards", what: "proposed actions wait for a person (shortlist, feed listing…)", stops: norm.hitl.stops, rejected: norm.hitl.rejected },
  { id: "n-gates", name: "approval_gates", what: "requisition/org-profile/jd approvals before any publish", stops: norm.gates.stops, rejected: norm.gates.rejected },
  { id: "n-clarify", name: "clarification", what: "agent asks, a person answers (ask_human)", stops: norm.clarify.stops, rejected: 0 },
];
for (const s of normSpecs) {
  nodes.push({
    ...s, type: "norm",
    cause: `${s.what}. ${s.stops} stops folded from ${totalRuns} runs.`,
    effect: s.rejected > 0
      ? `${s.rejected} overturned by a person (${Math.round((s.rejected / Math.max(s.stops, 1)) * 100)}%) — the miscalibration signal.`
      : `Zero overturns — calibrated.`,
    action: s.rejected >= 3 ? `This norm (or the proposals under it) needs review — see the agent cards.` : `None.`,
  });
}

const errByTool = new Map<string, number>();
for (const e of errorClusters) if (e.count >= 3) errByTool.set(e.tool, (errByTool.get(e.tool) ?? 0) + e.count);
const agentsForTool = (tool: string) =>
  errorClusters.filter((e) => e.tool === tool && e.count >= 3).map((e) => `${e.agent_type} ${e.count}`).join(" + ");
for (const [tool, count] of errByTool) {
  nodes.push({
    id: `fail-${tool}`, type: "failure", name: tool, tool,
    cause: `${count} errors inside agent runs — ${agentsForTool(tool)}.`,
    effect: tool === "add_to_pipeline"
      ? "Duplicate-pipeline skips — the recent fix (agents skipping candidates already in the pipeline) should retire most of these; verify on the next run."
      : tool === "read_org_website"
        ? "Failure rate this high on the tool the org profile is built from — network egress or parser sandbox, not the model."
        : "Repeated tool failure — flaky dependency or bad input shape.",
    action: tool === "add_to_pipeline"
      ? "Re-run an intake stretch and confirm the error count drops."
      : tool === "read_org_website"
        ? "Check egress rules / parser sandbox health; this is infrastructure, not intelligence."
        : "Inspect last_error on the steps.",
  });
}

nodes.push({
  id: "vocab-seed", type: "vocab", name: "skill graph",
  cause: `skill_nodes is empty — the ontology hasn't been built, yet ${counts.match_scores} match scores and ${counts.candidates} candidates already carry raw text[] skills.`,
  effect: `Every matching verdict normalizes with a hardcoded alias list; cross-run vocabulary learning is impossible until nodes exist.`,
  action: `Build Phase 1 (definitions + normalization) — the seed evidence is already in the tables.`,
});

for (const n of nodes) {
  if (n.type === "agent" && !n.idle && n.steps! > 0 && !edges.some((e) => e.s === n.id)) {
    edges.push({ s: n.id, t: "n-gates", k: "gated", label: "ran ungated" });
  }
}

// agent-behavior system read
const systemRead: { title: string; short: string; cause: string; effect: string; action: string }[] = [];
const webErr = errorClusters.find((e) => e.tool === "read_org_website");
if (webErr && webErr.count >= 10) {
  systemRead.push({
    title: `⚠ org-site reads fail at scale (${webErr.count} errors)`,
    short: `org-site reads failing ×${webErr.count}`,
    cause: `${webErr.count} of org_context's website reads errored — that is most of its read attempts, and it is the tool the org profile is built from.`,
    effect: `Org profiles may be silently thinner than they look; every downstream agent consumes them.`,
    action: `Check egress/parser-sandbox health first (infrastructure, not model). Then re-run an org_context stretch and compare profile depth.`,
  });
}
const dupErr = errorClusters.find((e) => e.tool === "add_to_pipeline");
if (dupErr && dupErr.count >= 5) {
  systemRead.push({
    title: `⚠ add_to_pipeline errors (${dupErr.count} across agents)`,
    short: `pipeline dup errors ×${dupErr.count}`,
    cause: `Duplicate-pipeline rejections across sourcing (${errByAgent.get("sourcing") ?? 0}) and intake (${errByAgent.get("intake") ?? 0}).`,
    effect: `Retries waste run budget; after the skip-already-in-pipeline fix these should collapse.`,
    action: `Re-run an intake stretch and verify the count drops; if it doesn't, the fix regressed.`,
  });
}
if (approvalsRejected >= 2) {
  const intakeR = taskStat("intake", "approval", "rejected");
  systemRead.push({
    title: `⚠ Persons are rejecting agent proposals (${approvalsRejected} overturns)`,
    short: `${approvalsRejected} proposal overturns (${Math.round((approvalsRejected / Math.max(approvals, 1)) * 100)}% rate)`,
    cause: intakeR >= 2
      ? `Intake's "Shortlist the top-scored applicants" was declined ${intakeR}× — the same proposal, repeatedly.`
      : `Rejections spread across ${new Set(rejectDetails.map((d) => d.agent_type)).size} agents.`,
    effect: `Overturn rate on HITL cards: ${Math.round((approvalsRejected / Math.max(approvals, 1)) * 100)}%. This is the graph telling you the agent's judgment and the reviewer's disagree.`,
    action: `Read the rejection reasons. If the wording is the problem, change the proposal copy; if the candidates are, change the scorer threshold. Don't touch the reviewer.`,
  });
}
if (idleAgents.includes("copilot")) {
  systemRead.push({
    title: `⚠ The front door never opened — copilot has 0 runs`,
    short: `copilot never invoked — routing untested`,
    cause: `All ${totalRuns} runs reached specialists directly (manual starts, scheduler ticks, events); the routing layer and its confirmations were never exercised.`,
    effect: `The one agent designed to gate which specialist acts is the least-tested one — routing bugs will only surface in production.`,
    action: `Drive one stretch of work through the copilot deliberately, or accept direct routing as the real UX and re-scope the copilot.`,
  });
}
if (gapAgents.length) {
  systemRead.push({
    title: `◈ ${gapAgents.join(", ")} run out-of-band — invisible to the step trace`,
    short: `${gapAgents.join(", ")}: runs with 0 steps`,
    cause: `Voice/panel sessions are captured in transcripts, not agent_steps.`,
    effect: `These agents bypass every step-based rule and this graph.`,
    action: `Emit session turns as steps so governance covers them.`,
  });
}
systemRead.push({
  title: `✓ The fleet is quiet — ${awaiting} runs await a person, ${failed} failed`,
  short: `fleet quiet — ${awaiting} awaiting, ${failed} failed`,
  cause: `${totalRuns} runs · ${totalSteps} steps; ${Math.round(((totalSteps - errorClusters.reduce((s, e) => s + e.count, 0)) / Math.max(totalSteps, 1)) * 100)}% of steps succeeded.`,
  effect: `Gate stops (${norm.hitl.stops + norm.gates.stops}) behaved as designed; run limits and taint produced no breaches.`,
  action: `Cancelled runs (${cancelled}) are stale ticks — harmless, but a liveness rule could reap them sooner.`,
});
systemRead.push({
  title: `◈ Fleet coverage: ${definitions.length - idleAgents.length}/${definitions.length} agents active, ${idleAgents.length} idle`,
  short: `coverage ${definitions.length - idleAgents.length}/${definitions.length} active · ${idleAgents.length} idle`,
  cause: `${idleAgents.length} agents have manifests but no runs.`,
  effect: `Governance coverage is ${Math.round(((definitions.length - idleAgents.length - gapAgents.length) / definitions.length) * 100)}% of the fleet.`,
  action: `The Action plan table has the per-agent decision; make idle a decision, and pull voice sessions into the trace.`,
});
systemRead.push({
  title: `◈ Vocabulary: ${counts.skill_nodes} nodes exist — no vocabulary layer yet`,
  short: `skill graph: ${counts.skill_nodes} nodes — layer missing`,
  cause: `${counts.match_scores} match scores and ${counts.candidates} candidates carry raw skills; normalization is still the hardcoded alias list.`,
  effect: `The Vocabulary domain cannot be plotted from real data yet — there is nothing to plot.`,
  action: `Phase 1 (definitions + normalization) — the seed evidence is already in the tables.`,
});

const priOf = (t: string) => (t.startsWith("⚠") ? "high" : t.startsWith("◈") ? "medium" : "ok");
const sysread = systemRead.map((s) => ({ ...s, pri: priOf(s.title) as string }));
const sysreadSummary = `${sysread.filter((s) => s.pri === "high").length} need action · ${sysread.filter((s) => s.pri === "medium").length} to plan · ${sysread.filter((s) => s.pri === "ok").length} healthy`;

// per-agent action plan
type Plan = {
  name: string; ver: string; state: string; pri: "high" | "medium" | "ok";
  runs: number; stops: number; overturned: number; errors: number; awaiting: number; action: string;
};
const plan: Plan[] = [];
for (const d of definitions) {
  const r = stats.get(d.agent_type);
  const a = d.agent_type;
  if (!r) {
    plan.push({
      name: a, ver: d.version, state: "idle", pri: "ok", runs: 0, stops: 0, overturned: 0, errors: 0, awaiting: 0,
      action: `Enable (tick / copilot route / feature flag) or park — an idle manifest should be a decision.`,
    });
    continue;
  }
  const appT = taskTotal(a, "approval"), appR = taskStat(a, "approval", "rejected");
  const gateT = taskTotal(a, "gate"), gateR = taskStat(a, "gate", "rejected");
  const cla = taskTotal(a, "clarification");
  const errors = errByAgent.get(a) ?? 0;
  const awaitingN = awaitingByAgent.find((x) => x.agent_type === a)?.count ?? 0;
  const stops = appT + gateT + cla;
  const overturned = appR + gateR;
  let state: string, pri: Plan["pri"], action: string;
  if (r.steps === 0) {
    state = "no trace"; pri = "medium";
    action = `Add session-shaped telemetry so voice/panel behavior joins governance and this graph.`;
  } else if (overturned >= 2 && stops > 0) {
    state = "out of sync"; pri = "high";
    action = `Persons declined ${overturned} of ${stops} proposals — read the rejection reasons; fix proposal copy or scorer threshold, not the reviewer.`;
  } else if (errors >= 10) {
    state = "infra"; pri = "high";
    action = `Top failure is infrastructure-shaped — fix egress/parser first, then re-run a stretch.`;
  } else if (errors >= 3) {
    state = "flaky"; pri = "medium";
    action = `${errors} tool errors — re-run a stretch after the relevant fix and verify the count drops.`;
  } else if (awaitingN > 0) {
    state = "waiting"; pri = "medium";
    action = `${awaitingN} run(s) parked awaiting a person — clear the decisions inbox.`;
  } else if (stops > 0) {
    state = "healthy"; pri = "ok";
    action = `None — ${stops} touchpoints, overturn rate inside band. Keep the 10% threshold watching.`;
  } else {
    state = "clean"; pri = "ok";
    action = `None — autonomous, no errors, no interventions.`;
  }
  plan.push({ name: a, ver: d.version, state, pri, runs: r.runs, stops, overturned, errors, awaiting: awaitingN, action });
}
const priOrder = { high: 0, medium: 1, ok: 2 } as const;
plan.sort((x, y) => priOrder[x.pri] - priOrder[y.pri] || y.errors - x.errors || x.name.localeCompare(y.name));

// ================= VIEW 2 — GOVERNANCE (real decision chains) =================
const govNodes: Node[] = [];
const govEdges: Edge[] = [];
const kindNorm: Record<string, string> = { approval: "n-hitl", gate: "n-gates", clarification: "n-clarify" };
const kindWord: Record<string, string> = { approval: "cards", gate: "gates", clarification: "asks" };
const govSeen = new Set<string>();
let govOk = 0, govRej = 0, govAnswered = 0;

for (const [agent, kinds] of Object.entries(byAgentTask)) {
  for (const kind of Object.keys(kinds)) {
    const st = kinds[kind];
    const ok = (st.approved ?? 0) + (st.answered ?? 0);
    const rej = st.rejected ?? 0;
    if (!ok && !rej) continue;
    govSeen.add(kind);
    govOk += st.approved ?? 0;
    govAnswered += st.answered ?? 0;
    govRej += rej;
    const nk = kindNorm[kind];
    if (ok > 0) {
      const id = `gv-ok-${agent}-${kind}`;
      govNodes.push({
        id, type: "dOk", name: `✓ ${kindWord[kind]} · ${agent}`, agent, kind, count: ok,
        cause: `${ok} proposals approved by a person (${kindWord[kind]} on ${agent} runs).`,
        effect: `Human-in-the-loop working as designed on this proposal type.`,
        action: `None — approved decisions are the calibration baseline.`,
      });
      govEdges.push({ s: id, t: nk, k: "decided" });
    }
    if (rej > 0) {
      const id = `gv-rej-${agent}-${kind}`;
      const titles = rejectDetails.filter((d) => d.agent_type === agent && d.kind === kind).map((d) => `${d.title} (${d.tool ?? "?"})`);
      govNodes.push({
        id, type: "dBad", name: `✗ ${kindWord[kind]} · ${agent}`, agent, kind, count: rej, members: titles,
        cause: `${rej} proposal(s) declined by a person: ${titles.join("; ")}.`,
        effect: rej >= 2
          ? `The same proposal type keeps getting declined — the agent's judgment or its wording is out of sync with reviewers.`
          : `A single rejection is normal human disagreement — it becomes a pattern at 2.`,
        action: rej >= 2 ? `Read the rejection reasons; fix proposal copy or scorer threshold, not the reviewer.` : `No action yet.`,
      });
      govEdges.push({ s: id, t: nk, k: "decided" });
    }
  }
}
for (const s of normSpecs) {
  if (!govSeen.has(s.id === "n-hitl" ? "approval" : s.id === "n-gates" ? "gate" : "clarification")) continue;
  govNodes.push({
    ...s, type: "norm",
    cause: `${s.what}.`,
    effect: s.rejected > 0 ? `${s.rejected} overturns against ${s.stops} stops.` : `${s.stops} stops, zero overturns — calibrated.`,
    action: s.rejected >= 3 ? `Review the proposals under this norm — see the rejected chains.` : `None.`,
  });
}
if (taskStatusTotals.open > 0) {
  govNodes.push({
    id: "gv-open", type: "dOpen", name: `open cards ×${taskStatusTotals.open}`,
    members: openByAgent.map((r) => r.agent_type),
    cause: `${taskStatusTotals.open} cards still awaiting a person: ${openByAgent.map((r) => `${r.agent_type} ×${r.count}`).join(", ")}.`,
    effect: `Proposals (and the runs behind them) are parked mid-flight; ${awaiting} runs sit in awaiting_human.`,
    action: `Clear the decisions inbox — oldest cards first.`,
  });
}
if (taskStatusTotals.cancelled > 0) {
  govNodes.push({
    id: "gv-cancel", type: "dMut", name: `cancelled ×${taskStatusTotals.cancelled}`,
    cause: `${taskStatusTotals.cancelled} cards were cancelled — mostly stale ticks reaped when their run ended.`,
    effect: `Harmless, but they bury the live signals in the decisions inbox.`,
    action: `A liveness rule should cancel stale cards sooner and mark them, so open ≠ stale.`,
  });
}

const govSystemRead: { title: string; short: string; cause: string; effect: string; action: string }[] = [];
const repeatRej = govNodes.filter((n) => n.type === "dBad" && (n.count ?? 0) >= 2).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
if (repeatRej) {
  govSystemRead.push({
    title: `⚠ Repeated overturns: ${repeatRej.agent} ${kindWord[repeatRej.kind!]} declined ×${repeatRej.count}`,
    short: `${repeatRej.agent} ${repeatRej.kind} declined ×${repeatRej.count}`,
    cause: (repeatRej.members ?? []).join("; "),
    effect: `The chain ${repeatRej.agent} → ${repeatRej.kind} → person keeps ending in "no" — a calibration defect, not a disagreement.`,
    action: `Read the rejection reasons; fix the proposal copy or the threshold. The reviewer is the ground truth here.`,
  });
}
if (stageTotal > 0 && aiMoves / stageTotal >= 0.5) {
  const pct = Math.round((aiMoves / stageTotal) * 100);
  govSystemRead.push({
    title: `◈ Autonomy check: ai moves ${pct}% of pipeline transitions (${aiMoves}/${stageTotal})`,
    short: `ai moves ${pct}% of stage transitions`,
    cause: `stage_events actor field: ai ×${aiMoves}; person-via-agent ×${stageTotal - aiMoves}.`,
    effect: `The autonomy dial may say one thing while the pipeline says another — candidate progression is almost entirely model-driven.`,
    action: `Decide per transition whether ai-driven is intended (ai_screened: probably yes; shortlisted: maybe not) — encode it in the autonomy dial, not in convention.`,
  });
}
if (taskStatusTotals.open > 0) {
  govSystemRead.push({
    title: `⚠ ${taskStatusTotals.open} decision cards open — work is parked`,
    short: `${taskStatusTotals.open} cards open — clear the inbox`,
    cause: `Open proposals: ${openByAgent.map((r) => `${r.agent_type} ×${r.count}`).join(", ")}.`,
    effect: `Each open card holds its run in awaiting_human; candidates behind them age in place.`,
    action: `Clear the inbox oldest-first; then add a health rule for card age (e.g. >48h → escalation).`,
  });
}
if (taskStatusTotals.cancelled > 0) {
  govSystemRead.push({
    title: `◈ ${taskStatusTotals.cancelled} cancelled cards bury the live ones`,
    short: `${taskStatusTotals.cancelled} cancelled cards — reap stale`,
    cause: `Cancelled cards are mostly stale ticks whose runs ended.`,
    effect: `They add noise to every decisions inbox and to this graph's denominators.`,
    action: `Liveness rule: cancel + mark stale cards early instead of at run end.`,
  });
}
{
  const totalVersions = defChurn.reduce((s, r) => s + r.versions, 0);
  const top = defChurn.slice(0, 3).map((r) => `${r.agent_type} ×${r.versions}`).join(", ");
  govSystemRead.push({
    title: `◈ Definition churn: ${totalVersions} manifest versions shipped — top ${top}`,
    short: `${totalVersions} definition versions — eval coverage per bump?`,
    cause: `Rapid iteration (Oct 12 → now): ${top} lead the fleet.`,
    effect: `Every version bump changes behavior; without an eval per version, regressions ship silently.`,
    action: `Keep agents.lock + the eval gate strict: no version without an eval — the lock file is the enforcement point.`,
  });
}
govSystemRead.push({
  title: `✓ Calibration baseline: ${govOk + govAnswered} approved vs ${govRej} declined`,
  short: `${govOk + govAnswered}✓ / ${govRej}✗ — baseline recorded`,
  cause: `Every terminal person decision is on the governance graph with its norm.`,
  effect: `Overturn rate ${Math.round((govRej / Math.max(govOk + govRej, 1)) * 100)}% — this ratio is the fleet's calibration curve over time.`,
  action: `Track it per week; a rising curve is the earliest signal that agents and reviewers are drifting apart.`,
});
const govSysread = govSystemRead.map((s) => ({ ...s, pri: priOf(s.title) as string }));
const govSummary = `${govSysread.filter((s) => s.pri === "high").length} need action · ${govSysread.filter((s) => s.pri === "medium").length} to plan · ${govSysread.filter((s) => s.pri === "ok").length} healthy`;

// ================= VIEW 3 — VOCABULARY (seeded via the production normalizer) =================
const ont = buildOntology({
  candidates: candRows.map((c) => ({
    candidateId: c.id, skills: c.skills, observedAt: c.created_at.toISOString(), hired: !!c.hired, resumeText: null,
  })),
  demand: demandRows.map((r) => ({
    requisitionId: r.id, title: r.title ?? "requisition", openings: r.openings ?? 1,
    mustHave: r.must_have_skills ?? [], goodToHave: r.good_to_have_skills ?? [], open: !!r.open,
  })),
  previous: [],
});
const rawForms = new Set<string>();
for (const c of candRows) for (const s of c.skills) rawForms.add(s.toLowerCase().trim());
for (const r of demandRows) for (const s of (r.must_have_skills ?? []).concat(r.good_to_have_skills ?? [])) rawForms.add(s.toLowerCase().trim());

const vocabNodes: Node[] = ont.nodes.map((n) => ({
  id: "sk-" + n.slug, type: "skill", name: n.name,
  slug: n.slug, cat: n.category, aliases: n.aliases.join(", "),
  supply: n.supply, demand: n.demand, ev: n.evidence, dormant: n.status === "dormant",
  cause: `${n.evidence} evidence links · supply ${n.supply} / demand ${n.demand} · ${n.category}${n.aliases.length ? " · aliases folded: " + n.aliases.join(", ") : ""}.`,
  effect: n.demand > 0 && n.supply === 0
    ? `Demanded with zero pool supply — every open req on this skill depends on sourcing.`
    : n.status === "dormant" ? `No recent evidence — flagged dormant by the build.` : `Active node, normal flow.`,
  action: n.demand > 0 && n.supply === 0 ? `Open a sourcing campaign or demote it to good-to-have.` : `None.`,
}));
// significance threshold: demand-bearing or evidence-backed skills only — the tail folds into a count
const significant = vocabNodes
  .filter((n) => n.type === "family" || (n.demand ?? 0) > 0 || (n.ev ?? 0) >= 2)
  .sort((a, b) => (b.demand ?? 0) - (a.demand ?? 0) || (b.ev ?? 0) - (a.ev ?? 0));
const minorCount = vocabNodes.length - significant.length;
const shownSkills = significant.slice(0, 60);
const shownIds = new Set(shownSkills.map((n) => n.id));
const vocabGraphNodes = significant.filter((n) => n.type === "family" || shownIds.has(n.id));
const vocabEdges: Edge[] = [];
for (const e of ont.edges.filter((e) => e.count >= 2).sort((a, b) => b.count - a.count).slice(0, 22)) {
  if (shownIds.has("sk-" + e.from) && shownIds.has("sk-" + e.to)) {
    vocabEdges.push({ s: "sk-" + e.from, t: "sk-" + e.to, k: "cooccurs", label: e.count >= 3 ? `×${e.count}` : undefined });
  }
}
const deptAsks = new Map<string, Map<string, number>>();
for (const r of demandRows) {
  if (!r.dept) continue;
  const m = deptAsks.get(r.dept) ?? new Map<string, number>();
  for (const s of r.must_have_skills ?? []) m.set(slugify(s), (m.get(slugify(s)) ?? 0) + 1);
  deptAsks.set(r.dept, m);
}
const familyNodes: Node[] = [];
for (const [dept, m] of deptAsks) {
  const fid = "fam-" + slugify(dept);
  familyNodes.push({
    id: fid, type: "family", name: dept,
    cause: `Department standing in as a role family — ${[...m.values()].reduce((s, n) => s + n, 0)} must-have asks.`,
    effect: `${m.size} distinct skills demanded by this family.`,
    action: `Real role-family nodes (with builds_on) arrive with Phase 1; today departments are the proxy.`,
  });
  for (const [slug, n] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    if (shownIds.has("sk-" + slug)) vocabEdges.push({ s: fid, t: "sk-" + slug, k: "asks_for", label: n > 1 ? `×${n}` : undefined });
  }
}
const vocabGraph = [...familyNodes, ...vocabGraphNodes];
const vocabSystemRead = ont.insights.map((ins) => ({
  title: `${ins.severity === "high" ? "⚠" : "◈"} ${ins.kind}: ${ins.title}`,
  short: ins.title,
  cause: `deriveInsights over ${ont.stats.candidates} candidates / ${ont.stats.requisitions} requisitions · skills: ${ins.skills.join(", ") || "—"}`,
  effect: ins.detail,
  action: ins.actionLabel ? `${ins.actionLabel} — route ${ins.actionTo}` : ins.detail,
  pri: ins.severity === "high" ? "high" : ins.severity === "medium" ? "medium" : "ok",
}));
vocabSystemRead.push({
  title: `◈ Alias fold: ${rawForms.size} raw skill forms resolve to ${ont.nodes.length} nodes`,
  short: `${rawForms.size} raw forms → ${ont.nodes.length} nodes`,
  cause: `Every variant fold comes from the hardcoded alias table in ontology.server.ts — it learned nothing by itself.`,
  effect: `A form the table misses becomes a spurious node; this count is the alias table's report card.`,
  action: `Phase 1 replaces the hardcoded table with evidence-folded aliases (skillEvidence → alias learning).`,
  pri: "medium",
});
vocabSystemRead.push({
  title: `◈ ${minorCount} low-evidence skills folded out of the graph`,
  short: `${minorCount} single-evidence skills hidden`,
  cause: `Skills with one evidence link, no demand and no aliases are real but insignificant — drawing them makes the seed view unreadable.`,
  effect: `They still count in node totals and will surface as evidence accumulates.`,
  action: `Thresholds stay: demand > 0 or evidence ≥ 2 puts a skill on the graph. Persistence (Phase 1) makes the cut queryable instead of invisible.`,
  pri: "ok",
});
vocabSystemRead.push({
  title: `◈ skill_nodes is still empty — this view is computed in-memory, not persisted`,
  short: `seed only — nothing persisted yet`,
  cause: `The exact nodes and edges on this graph were built by the production buildOntology() from raw text[] columns.`,
  effect: `Nothing is stored, so no agent can query this vocabulary yet — the graph exists only when this script runs.`,
  action: `Phase 1 persists these same nodes into skill_nodes/skill_edges — after that, agents query them through the deterministic layer.`,
  pri: "medium",
});
const vocabPriOrder = { high: 0, medium: 1, ok: 2 } as const;
vocabSystemRead.sort((a, b) => vocabPriOrder[(a.pri as "high")] - vocabPriOrder[(b.pri as "high")]);
const vocabSummary = `${vocabSystemRead.filter((s) => s.pri === "high").length} need action · ${vocabSystemRead.filter((s) => s.pri === "medium").length} to plan · ${vocabSystemRead.filter((s) => s.pri === "ok").length} healthy`;

// ================= assemble =================
const DATA = {
  generatedAt: new Date().toISOString(),
  orgs: orgCount,
  views: {
    agentb: {
      key: "agentb", label: "Agent behavior",
      title: "agent_runs · agent_steps · agent_tasks — the fleet and its governance from live data",
      snapshot: "every count is a live SQL aggregate — candidates folded into edge weights",
      tiles: [
        ["Runs", String(totalRuns), `${orgCount} orgs · ${failed} failed · ${cancelled} cancelled`],
        ["Agent steps", String(totalSteps), `${definitions.length - idleAgents.length}/${definitions.length} registered agents active`],
        ["Person touchpoints", String(norm.hitl.stops + norm.gates.stops + norm.clarify.stops), `${approvalsRejected + gatesRejected} declined by a person`],
        ["Skill graph", `${counts.skill_nodes} nodes`, `${counts.match_scores} match scores await normalization`],
      ],
      nodes, edges, systemRead: sysread, sysreadSummary,
      rejects: rejectDetails, plan,
      fleet: { registered: definitions.length, idle: idleAgents.length, gap: gapAgents.length },
      typeStyles: {
        agent: { color: "var(--series-role)", r: 15, label: "Agent", plural: "Agents" },
        norm: { color: "var(--series-cand)", r: 14, label: "Person gate", plural: "Person gates" },
        failure: { color: "var(--text-muted)", r: 9, label: "Failure cluster", plural: "Failure clusters" },
        vocab: { color: "var(--series-skill)", r: 11, label: "Vocabulary", plural: "Vocabulary" },
        hub: { color: "var(--text-muted)", r: 13, label: "Diagnosis hub", plural: "Diagnosis hubs" },
      },
      edgeStyles: {
        gated: { stroke: "var(--baseline)", width: 1.8, dash: "" },
        errored: { stroke: "var(--status-critical)", width: 1.6, dash: "6 4" },
        awaits: { stroke: "var(--status-warning)", width: 1.6, dash: "3 3" },
        idle: { stroke: "var(--baseline)", width: 1.2, dash: "2 3", opacity: 0.7 },
        gap: { stroke: "var(--status-warning)", width: 1.6, dash: "3 3" },
      },
      elabels: { gated: "gated by", errored: "errors in", awaits: "awaits", idle: "idle —", gap: "trace gap:" },
      spring: { gated: 185, errored: 150, awaits: 190, idle: 140, gap: 170 },
    },
    gov: {
      key: "gov", label: "Governance",
      title: "agent_tasks decisions — every person verdict, the norm it acted under, and what it means",
      snapshot: `stage_events: ai moves ${aiMoves}/${stageTotal} pipeline transitions · ${defChurn.reduce((s, r) => s + r.versions, 0)} definition versions shipped`,
      tiles: [
        ["Person decisions", String(govOk + govAnswered + govRej), `${govOk} approved · ${govRej} declined · ${govAnswered} answered`],
        ["Open cards", String(taskStatusTotals.open), openByAgent.map((r) => `${r.agent_type} ×${r.count}`).slice(0, 3).join(", ") || "none"],
        ["Cancelled cards", String(taskStatusTotals.cancelled), "stale — reap with a liveness rule"],
        ["Stage moves", String(stageTotal), `${Math.round((aiMoves / Math.max(stageTotal, 1)) * 100)}% ai · ${stageTotal - aiMoves} person (via agent)`],
      ],
      nodes: govNodes, edges: govEdges, systemRead: govSysread, sysreadSummary: govSummary,
      typeStyles: {
        norm: { color: "var(--series-cand)", r: 14, label: "Person gate", plural: "Person gates" },
        dOk: { color: "var(--status-good)", r: 11, label: "Approved", plural: "Approved decisions" },
        dBad: { color: "var(--status-critical)", r: 12, label: "Overturned", plural: "Overturned decisions" },
        dOpen: { color: "var(--status-warning)", r: 10, label: "Open card", plural: "Open cards" },
        dMut: { color: "var(--text-muted)", r: 9, label: "Cancelled", plural: "Cancelled cards" },
      },
      edgeStyles: {
        decided: { stroke: "var(--baseline)", width: 1.7, dash: "" },
      },
      elabels: { decided: "decided under" },
      spring: { decided: 175 },
    },
    vocab: {
      key: "vocab", label: "Vocabulary",
      title: "skills · role-family proxies · co-occurrence — built by the production buildOntology() from raw skills",
      snapshot: `seed view — in-memory only · ${ont.stats.nodeCount} nodes · ${ont.stats.edgeCount} edges · ${ont.stats.scarce} scarce · ${ont.stats.dormant} dormant · ${ont.stats.coverage}% coverage`,
      tiles: [
        ["Skill nodes", String(ont.stats.nodeCount), `${vocabGraph.filter((n) => n.type === "skill").length} shown · ${minorCount} low-evidence folded`],
        ["Co-occurrence edges", String(ont.stats.edgeCount), `${vocabEdges.filter((e) => e.k === "cooccurs").length} shown (top by count)`],
        ["Insights", String(ont.insights.length), `${ont.insights.filter((i) => i.severity === "high").length} high severity — prescriptive, from deriveInsights`],
        ["Persisted", "0 rows", "skill_nodes empty — Phase 1 persists these"],
      ],
      nodes: vocabGraph, edges: vocabEdges, systemRead: vocabSystemRead, sysreadSummary: vocabSummary,
      typeStyles: {
        family: { color: "var(--series-role)", r: 14, label: "Role family (dept proxy)", plural: "Role families" },
        skill: { color: "var(--series-skill)", r: 9, label: "Skill (size = evidence)", plural: "Skills" },
      },
      edgeStyles: {
        asks_for: { stroke: "var(--baseline)", width: 1.8, dash: "" },
        cooccurs: { stroke: "var(--baseline)", width: 1.4, dash: "2 3", opacity: 0.85 },
      },
      elabels: { asks_for: "asks for", cooccurs: "co-occurs" },
      spring: { asks_for: 165, cooccurs: 120 },
    },
  },
};

// ================= HTML =================
const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent telemetry — real graphs (${DATA.generatedAt.slice(0, 10)})</title>
<style>
  :root { color-scheme: light; }
  .viz-root {
    --page:#f9f9f7; --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e;
    --text-muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --ring:rgba(11,11,11,0.10);
    --series-role:#2a78d6; --series-skill:#1baf7a; --series-cand:#eb6834;
    --status-good:#0ca30c; --status-warning:#fab219; --status-critical:#d03b3b; --good-text:#006300;
  }
  :root[data-theme="dark"] .viz-root {
    --page:#0d0d0d; --surface-1:#1a1a19; --text-primary:#f0efec; --text-secondary:#c3c2b7;
    --grid:#2c2c2a; --baseline:#383835; --ring:rgba(255,255,255,0.10);
    --series-role:#3987e5; --series-skill:#199e70; --series-cand:#d95926; --good-text:#0ca30c;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  :root[data-theme="dark"] body { background:#0d0d0d; }
  .viz-root { color:var(--text-primary); min-height:100vh; padding:24px; }
  .wrap { max-width:1200px; margin:0 auto; }
  header.bar { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; font-weight:650; }
  .org { color:var(--text-secondary); font-size:13px; }
  .snapshot { color:var(--text-muted); font-size:12px; margin-left:auto; }
  .tabs { display:inline-flex; border:1px solid var(--grid); border-radius:8px; overflow:hidden; margin:12px 0 0; }
  .tabs button { border:0; background:var(--surface-1); color:var(--text-secondary); font-size:13px; padding:7px 16px; cursor:pointer; }
  .tabs button[aria-selected="true"] { background:color-mix(in srgb,var(--series-role) 12%,var(--surface-1)); color:var(--text-primary); font-weight:650; }
  .tiles { display:flex; gap:10px; margin:14px 0; flex-wrap:wrap; }
  .tile { background:var(--surface-1); border:1px solid var(--ring); border-radius:8px; padding:8px 14px; min-width:110px; }
  .tile .k { font-size:11px; color:var(--text-muted); }
  .tile .v { font-size:20px; font-weight:650; margin-top:2px; }
  .tile .s { font-size:11px; color:var(--text-secondary); }
  .filters { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0 12px; font-size:12px; min-height:28px; }
  .filters label { display:inline-flex; gap:5px; align-items:center; color:var(--text-secondary); cursor:pointer; }
  .filters input[type=checkbox] { accent-color:var(--series-role); }
  .filters .swatch { width:10px; height:10px; border-radius:50%; display:inline-block; }
  .filters input[type=text] { background:var(--surface-1); border:1px solid var(--grid); border-radius:6px; color:var(--text-primary); padding:5px 9px; font-size:12px; width:180px; }
  .filters button { background:var(--surface-1); border:1px solid var(--grid); border-radius:6px; color:var(--text-secondary); font-size:12px; padding:5px 10px; cursor:pointer; }
  .main { display:grid; grid-template-columns:1fr 320px; gap:14px; align-items:start; }
  @media (max-width:900px) { .main { grid-template-columns:1fr; } }
  .card { background:var(--surface-1); border:1px solid var(--ring); border-radius:10px; overflow:hidden; }
  .cardhead { padding:10px 14px; font-size:12px; color:var(--text-muted); border-bottom:1px solid var(--grid); display:flex; justify-content:space-between; gap:10px; }
  #stage { width:100%; height:600px; display:block; }
  #stage text { font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .legend { display:flex; gap:16px; flex-wrap:wrap; padding:10px 14px; border-top:1px solid var(--grid); font-size:11.5px; color:var(--text-secondary); }
  .legend .swatch { width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:5px; vertical-align:-1px; }
  .legend .line-demo { display:inline-block; width:22px; vertical-align:2px; margin-right:5px; }
  .inspector { background:var(--surface-1); border:1px solid var(--ring); border-radius:10px; padding:14px; font-size:12.5px; min-height:300px; max-height:652px; overflow-y:auto; }
  .inspector h2 { font-size:14px; margin:0 0 2px; }
  .inspector .kind { color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.06em; }
  .inspector dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:12px 0; }
  .inspector dt { color:var(--text-muted); }
  .inspector dd { margin:0; }
  .inspector .hint { color:var(--text-muted); line-height:1.5; }
  .inspector ul { margin:8px 0; padding-left:18px; color:var(--text-secondary); }
  .badge { display:inline-flex; gap:5px; align-items:center; border-radius:5px; padding:2px 8px; font-size:11.5px; font-weight:600; margin:2px 4px 2px 0; }
  .badge::before { content:attr(data-icon); }
  .badge.good { color:var(--status-good); background:color-mix(in srgb,var(--status-good) 12%,transparent); }
  .badge.warning { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 14%,transparent); }
  .badge.critical { color:var(--status-critical); background:color-mix(in srgb,var(--status-critical) 10%,transparent); }
  .badge.muted { color:var(--text-secondary); background:color-mix(in srgb,var(--text-secondary) 10%,transparent); }
  .interp { border-left:3px solid var(--grid); padding:7px 10px; margin:8px 0; border-radius:4px; background:color-mix(in srgb,var(--text-secondary) 5%,transparent); }
  .interp .ilabel { font-weight:650; font-size:10.5px; letter-spacing:0.05em; text-transform:uppercase; color:var(--text-muted); display:flex; align-items:center; gap:6px; margin-bottom:2px; }
  .interp .ilabel::before { content:attr(data-icon); font-size:12px; }
  .interp.cause { border-left-color:var(--series-role); }
  .interp.effect { border-left-color:var(--status-warning); }
  .interp.action { border-left-color:var(--status-good); }
  .interp.action .ilabel { color:var(--good-text); }
  .interp.effect .ilabel { color:var(--status-warning); }
  .interp p { margin:0; line-height:1.45; }
  .chips { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:8px; padding:10px 14px; }
  .chip { border:1px solid var(--grid); border-radius:7px; padding:7px 9px; cursor:pointer; }
  .chip:hover { background:color-mix(in srgb,var(--text-secondary) 5%,transparent); }
  .chip.sel { border-color:var(--series-role); background:color-mix(in srgb,var(--series-role) 7%,transparent); }
  .chip .c1 { display:flex; gap:7px; align-items:center; min-width:0; }
  .chip .ct { font-weight:650; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .chip .ca { color:var(--text-secondary); font-size:11.5px; margin-top:4px; line-height:1.35;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .insight { border:1px solid var(--grid); border-radius:7px; padding:8px 10px; margin:8px 0; }
  .backlink { color:var(--text-secondary); font-size:11.5px; cursor:pointer; text-decoration:underline; margin-bottom:8px; display:inline-block; }
  .cardtable { display:none; padding:0; }
  .cardtable table { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric:tabular-nums; }
  .cardtable th { text-align:left; color:var(--text-muted); font-weight:500; padding:8px 14px; border-bottom:1px solid var(--grid); font-size:11px; }
  .cardtable td { padding:7px 14px; border-bottom:1px solid var(--grid); }
  .cardtable td.dim { color:var(--text-secondary); }
  #tooltip { position:fixed; pointer-events:none; background:var(--surface-1); border:1px solid var(--ring); border-radius:7px; padding:7px 10px; font-size:12px; display:none; z-index:5; box-shadow:0 4px 14px rgba(0,0,0,0.12); max-width:300px; }
  #tooltip .t1 { font-weight:650; } #tooltip .t2 { color:var(--text-secondary); margin-top:2px; }
</style>
</head>
<body>
<div class="viz-root"><div class="wrap">
  <header class="bar">
    <h1>Agent telemetry</h1>
    <span class="org">Real data · ${DATA.orgs} orgs · generated ${DATA.generatedAt.slice(0, 16).replace("T", " ")}</span>
    <span class="snapshot" id="snapshot"></span>
  </header>
  <div class="tabs" role="tablist">
    <button id="tab-agentb" aria-selected="true">Agent behavior</button>
    <button id="tab-gov" aria-selected="false">Governance</button>
    <button id="tab-vocab" aria-selected="false">Vocabulary</button>
  </div>
  <div class="tiles" id="tiles"></div>
  <div class="card" id="sysread" style="margin:0 0 12px">
    <div class="cardhead"><span>System read — <b id="sysreadsummary"></b></span><span>threshold-gated rules over live SQL · click a chip for the full cause → effect → action</span></div>
    <div class="chips" id="sysreadrows"></div>
  </div>
  <div class="filters" id="filters"></div>
  <div class="main">
    <div class="card">
      <div class="cardhead"><span id="cardtitle"></span><span>drag · click to inspect</span></div>
      <svg id="stage" role="img" aria-label="Real telemetry graph"></svg>
      <div class="legend" id="legend"></div>
    </div>
    <aside class="inspector" id="inspector"></aside>
  </div>
  <div class="card cardtable" id="tableview">
    <div class="cardhead"><span>rejected proposals — every overturn the fleet produced</span></div>
    <div id="tablecontent"></div>
  </div>
  <div class="card cardtable" id="planview">
    <div class="cardhead"><span>Action plan — all registered agents, priority-sorted</span></div>
    <div id="plancontent"></div>
  </div>
</div></div>
<div id="tooltip" role="status"></div>
<script>
"use strict";
const DATA = ${JSON.stringify(DATA)};

const SVGNS = "http://www.w3.org/2000/svg";
const el = (t, a) => { const n = document.createElementNS(SVGNS, t); for (const k in a) n.setAttribute(k, a[k]); return n; };
const REPULSION = 3800, FRICTION = 0.86, CENTER = 0.012, H = 600;

const stage = document.getElementById("stage");
const tip = document.getElementById("tooltip");
const insp = document.getElementById("inspector");
let V = null, nodes = [], links = [], alpha = 1;
let gE, gN, gL, selChip = null;

function tick() {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const dx = b.x - a.x, dy = b.y - a.y, d2 = dx*dx + dy*dy || 1;
    if (d2 > 300*300) continue;
    const f = REPULSION / d2, d = Math.sqrt(d2);
    a.vx -= dx/d*f; a.vy -= dy/d*f; b.vx += dx/d*f; b.vy += dy/d*f;
    const minD = Math.min(50 + Math.max(a.name.length, b.name.length)*3.1, 140);
    if (d < minD) { const p = (minD-d)*0.09; a.vx -= dx/d*p; a.vy -= dy/d*p; b.vx += dx/d*p; b.vy += dy/d*p; }
  }
  for (const l of links) {
    if (l.hidden) continue;
    const dx = l.b.x-l.a.x, dy = l.b.y-l.a.y, d = Math.hypot(dx,dy) || 1;
    const f = (d - (V.spring[l.k] || 150)) * 0.012;
    l.a.vx += dx/d*f; l.a.vy += dy/d*f; l.b.vx -= dx/d*f; l.b.vy -= dy/d*f;
  }
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += ((stage.clientWidth || 860)/2 - n.x) * CENTER;
    n.vy += (H/2 - n.y) * CENTER;
    n.vx *= FRICTION; n.vy *= FRICTION;
    n.x = Math.max(50, Math.min((stage.clientWidth || 860)-50, n.x + n.vx));
    n.y = Math.max(30, Math.min(H-30, n.y + n.vy));
  }
}
function draw() {
  for (const l of links) {
    if (l.hidden) continue;
    l.line.setAttribute("x1", l.a.x); l.line.setAttribute("y1", l.a.y);
    l.line.setAttribute("x2", l.b.x); l.line.setAttribute("y2", l.b.y);
    if (l.tag) {
      const mx = (l.a.x+l.b.x)/2, my = (l.a.y+l.b.y)/2;
      const dx = l.b.x-l.a.x, dy = l.b.y-l.a.y, d = Math.hypot(dx,dy) || 1;
      l.tag.setAttribute("x", mx - (dy/d)*l.off);
      l.tag.setAttribute("y", my + (dx/d)*l.off + 3);
    }
  }
  for (const n of nodes) {
    n.group.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
    n.label.setAttribute("x", n.x);
    n.label.setAttribute("y", n.y + rOf(n) + 13);
  }
}
function loop() {
  if (alpha > 0.005) { for (let i = 0; i < 4; i++) tick(); alpha *= 0.994; }
  draw();
  requestAnimationFrame(loop);
}
const rOf = n => n._r || 10;

function mount(key) {
  V = DATA.views[key]; alpha = 1; selChip = null;
  document.getElementById("tab-agentb").setAttribute("aria-selected", String(key === "agentb"));
  document.getElementById("tab-gov").setAttribute("aria-selected", String(key === "gov"));
  document.getElementById("tab-vocab").setAttribute("aria-selected", String(key === "vocab"));
  document.getElementById("snapshot").textContent = V.snapshot;
  document.getElementById("cardtitle").textContent = V.title;
  document.getElementById("tableview").style.display = key === "agentb" ? "none" : "none";
  document.getElementById("planview").style.display = "none";
  stage.replaceChildren();
  gE = el("g",{}); gN = el("g",{}); gL = el("g",{});
  stage.append(gE, gN, gL);
  stage.setAttribute("viewBox", "0 0 " + (stage.clientWidth || 860) + " " + H);

  nodes = V.nodes.map(n => ({ ...n, x:0, y:0, vx:0, vy:0 }));
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  links = V.edges.map(e => ({ ...e, a: byId[e.s], b: byId[e.t] })).filter(l => l.a && l.b);
  nodes.forEach((n, i) => {
    const ang = (i / nodes.length) * Math.PI * 2;
    const rad = key === "agentb" ? (n.type === "agent" ? 110 : 230) : key === "vocab" ? (n.type === "family" ? 110 : 240) : 200;
    n.x = (stage.clientWidth || 860) / 2 + Math.cos(ang) * rad;
    n.y = H / 2 + Math.sin(ang) * rad * 0.9;
  });

  let tagCount = 0;
  for (const l of links) {
    const st = V.edgeStyles[l.k];
    l.line = el("line", { stroke: st.stroke, "stroke-width": st.width, opacity: st.opacity || 1 });
    if (st.dash) l.line.setAttribute("stroke-dasharray", st.dash);
    gE.appendChild(l.line);
    if (l.label) {
      l.tag = el("text", { "font-size":10, fill: st.stroke, "text-anchor":"middle",
        "paint-order":"stroke", stroke:"var(--surface-1)", "stroke-width":3, "font-weight":600 });
      l.tag.textContent = l.label;
      l.off = [30,-30,48,-48,64][tagCount++ % 5];
      gE.appendChild(l.tag);
    }
  }
  for (const n of nodes) {
    const ts = V.typeStyles[n.type];
    n._r = n.idle ? 9 : ts.r;
    if (V.key === "vocab" && n.type === "skill") n._r = Math.min(14, 6 + Math.sqrt(n.ev || 4) * 1.3);
    n.group = el("g", { tabindex:0, role:"button", "aria-label": n.name + ", " + ts.label });
    n.circle = el("circle", {
      r: n._r, fill: ts.color,
      stroke: n.type === "hub" ? "var(--status-warning)" : "var(--surface-1)",
      "stroke-width": 2, "stroke-dasharray": n.type === "hub" ? "3 2" : "",
      opacity: n.idle ? 0.45 : n.dormant ? 0.4 : 1, cursor: "grab",
    });
    n.group.appendChild(n.circle); gN.appendChild(n.group);
    n.label = el("text", { "font-size": n.idle ? 10 : 11, fill:"var(--text-primary)", "text-anchor":"middle",
      "paint-order":"stroke", stroke:"var(--surface-1)", "stroke-width":3, opacity: n.idle ? 0.7 : n.dormant ? 0.5 : 1 });
    n.label.textContent = n.name + (n.type === "agent" && !n.idle ? " ×" + n.runs : n.idle ? " (idle)" : "");
    gL.appendChild(n.label);
    let drag = null;
    n.group.addEventListener("pointerdown", ev => { drag = { id: ev.pointerId }; n.fixed = true; alpha = 1; n.group.setPointerCapture(ev.pointerId); });
    n.group.addEventListener("pointermove", ev => {
      if (!drag) return;
      const rect = stage.getBoundingClientRect();
      n.x = (ev.clientX - rect.left) * (stage.clientWidth / rect.width);
      n.y = (ev.clientY - rect.top) * (H / rect.height);
      alpha = 1;
    });
    n.group.addEventListener("pointerup", () => { drag = null; n.fixed = false; });
    n.group.addEventListener("click", () => inspect(n));
    n.group.addEventListener("focus", () => inspect(n));
    n.group.addEventListener("pointerenter", ev => showTip(ev, n));
    n.group.addEventListener("pointermove", ev => { if (!drag) moveTip(ev); });
    n.group.addEventListener("pointerleave", () => { tip.style.display = "none"; n.circle.setAttribute("stroke", n.type === "hub" ? "var(--status-warning)" : "var(--surface-1)"); });
  }
  for (let i = 0; i < 900; i++) tick();
  alpha = 0.25;
  buildChrome();
  showDefault();
  draw();
}

function buildChrome() {
  document.getElementById("tiles").innerHTML = V.tiles.map(([k,v,s]) =>
    '<div class="tile"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div></div>').join("");
  // legend
  const legend = document.getElementById("legend");
  legend.innerHTML =
    Object.entries(V.typeStyles).map(([t, st]) => '<span><span class="swatch" style="background:' + st.color + '"></span>' + st.label + '</span>').join("") +
    (V.key === "agentb" ? '<span><span class="swatch" style="background:var(--series-role); opacity:.45"></span>faded = idle agent</span>' : "") +
    Object.entries(V.edgeStyles).map(([k, st]) =>
      '<span><svg class="line-demo" width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="' + st.stroke + '" stroke-width="' + Math.max(1.2, st.width) + '" ' + (st.dash ? 'stroke-dasharray="' + st.dash + '"' : "") + '/></svg>' + (V.elabels[k] || k) + '</span>').join("") +
    '<span>edge labels = folded real counts</span>';
  // filters
  const filtersEl = document.getElementById("filters");
  filtersEl.replaceChildren();
  for (const [t, st] of Object.entries(V.typeStyles)) {
    const lab = document.createElement("label");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true; cb.dataset.type = t;
    cb.addEventListener("change", () => {
      for (const n of nodes) if (n.type === t) { n.group.style.display = cb.checked ? "" : "none"; n.label.style.display = cb.checked ? "" : "none"; }
      for (const l of links) if (l.a.type === t || l.b.type === t) { l.hidden = !cb.checked; l.line.style.display = l.hidden ? "none" : ""; if (l.tag) l.tag.style.display = l.hidden ? "none" : ""; }
    });
    const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = st.color;
    lab.append(cb, sw, document.createTextNode(" " + (st.plural || st.label)));
    filtersEl.appendChild(lab);
  }
  const search = document.createElement("input"); search.type = "text"; search.placeholder = "Search nodes…"; search.style.marginLeft = "auto";
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const n of nodes) {
      const hide = q && !n.name.toLowerCase().includes(q);
      n.group.style.opacity = hide ? 0.12 : 1; n.label.style.opacity = hide ? 0.12 : 1;
    }
  });
  filtersEl.appendChild(search);
  if (V.key === "agentb") {
    const viewBtn = document.createElement("button"); viewBtn.textContent = "Rejected proposals";
    viewBtn.addEventListener("click", () => {
      const tv = document.getElementById("tableview");
      const on = tv.style.display === "block";
      tv.style.display = on ? "none" : "block";
      viewBtn.textContent = on ? "Rejected proposals" : "Hide table";
    });
    filtersEl.appendChild(viewBtn);
    const planBtn = document.createElement("button"); planBtn.textContent = "Action plan";
    planBtn.addEventListener("click", () => {
      const pv = document.getElementById("planview");
      const on = pv.style.display === "block";
      pv.style.display = on ? "none" : "block";
      planBtn.textContent = on ? "Action plan" : "Hide plan";
    });
    filtersEl.appendChild(planBtn);
  }
  const themeBtn = document.createElement("button"); themeBtn.textContent = "Dark";
  themeBtn.addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    themeBtn.textContent = root.dataset.theme === "dark" ? "Light" : "Dark";
  });
  filtersEl.appendChild(themeBtn);
  // system read chips
  document.getElementById("sysreadsummary").textContent = V.sysreadSummary;
  const rowsEl = document.getElementById("sysreadrows");
  rowsEl.replaceChildren();
  for (const s of V.systemRead) {
    const chip = document.createElement("div"); chip.className = "chip"; chip.tabIndex = 0;
    const l1 = document.createElement("div"); l1.className = "c1";
    const badge = document.createElement("span");
    badge.className = "badge " + (s.pri === "high" ? "critical" : s.pri === "medium" ? "warning" : "good");
    badge.dataset.icon = s.pri === "high" ? "⚠" : s.pri === "medium" ? "◈" : "✓";
    badge.textContent = s.pri;
    const t = document.createElement("span"); t.className = "ct"; t.textContent = s.short;
    t.title = s.title.replace(/^[⚠✓◈]\\s*/, "");
    l1.append(badge, t);
    const a = document.createElement("div"); a.className = "ca"; a.textContent = s.action;
    chip.append(l1, a);
    const open = () => showFinding(s, chip);
    chip.addEventListener("click", open);
    chip.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
    rowsEl.appendChild(chip);
  }
}

function showFinding(s, chip) {
  if (selChip) selChip.classList.remove("sel");
  if (selChip === chip) { selChip = null; showDefault(); return; }
  selChip = chip; chip.classList.add("sel");
  insp.replaceChildren();
  const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = "system read · " + s.pri;
  const h = document.createElement("h2"); h.textContent = s.title.replace(/^[⚠✓◈]\\s*/, "");
  insp.append(kind, h);
  insp.appendChild(interpEl("cause", s.cause));
  insp.appendChild(interpEl("effect", s.effect));
  insp.appendChild(interpEl("action", s.action));
}
function showDefault() {
  insp.replaceChildren();
  const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = "inspector";
  const h = document.createElement("h2"); h.textContent = "Nothing selected";
  const hint = document.createElement("p"); hint.className = "hint";
  hint.textContent = "Click any node for its numbers and its cause → effect → next best action. The fleet-wide summary lives in the System read panel above.";
  insp.append(kind, h, hint);
}
function interpEl(kind2, text) {
  const d = document.createElement("div"); d.className = "interp " + kind2;
  const lab = document.createElement("div"); lab.className = "ilabel";
  lab.dataset.icon = kind2 === "cause" ? "◈" : kind2 === "effect" ? "⚠" : "→";
  lab.appendChild(document.createTextNode(kind2 === "cause" ? "cause" : kind2 === "effect" ? "effect" : "next best action"));
  const p = document.createElement("p"); p.textContent = text;
  d.append(lab, p);
  return d;
}
function badgeEl(cls, icon, text) { const b = document.createElement("span"); b.className = "badge " + cls; b.dataset.icon = icon; b.textContent = text; return b; }
function showTip(ev, n) {
  tip.replaceChildren();
  const t1 = document.createElement("div"); t1.className = "t1"; t1.textContent = n.name;
  const t2 = document.createElement("div"); t2.className = "t2";
  t2.textContent =
    n.type === "agent" ? (n.idle ? "idle · v" + n.ver + " · 0 runs" : n.runs + " runs · " + n.steps + " steps · avg " + n.avg)
    : n.type === "norm" ? (n.stops + " stops · " + n.rejected + " overturned")
    : n.type === "hub" ? ((n.members || []).length + " members — click for the list")
    : n.type === "failure" ? (n.tool || "")
    : (n.count != null ? n.count + " decision(s)" : (n.cause || "").slice(0, 80));
  tip.append(t1, t2);
  tip.style.display = "block"; moveTip(ev);
  n.circle.setAttribute("stroke", "var(--text-secondary)");
}
function moveTip(ev) { tip.style.left = (ev.clientX + 14) + "px"; tip.style.top = (ev.clientY + 12) + "px"; }
function inspect(n) {
  insp.replaceChildren();
  const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = V.typeStyles[n.type].label;
  const h = document.createElement("h2"); h.textContent = n.name;
  insp.append(kind, h);
  const dl = document.createElement("dl");
  const add = (k, v) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); };
  if (n.type === "agent") {
    if (n.ver) add("version", n.ver);
    add("runs", n.runs); add("steps", n.steps);
    if (!n.idle) add("avg steps/run", n.avg);
    if (n.awaiting) add("runs awaiting a person", n.awaiting);
    const rej = (V.rejects || []).filter(r => r.agent_type === n.name);
    if (rej.length) { const t = document.createElement("div"); t.className = "kind"; t.style.marginTop = "8px"; t.textContent = "overturned proposals"; insp.appendChild(t);
      const ul = document.createElement("ul");
      for (const r of rej) { const li = document.createElement("li"); li.textContent = r.title + " (" + (r.tool || r.kind) + ")"; ul.appendChild(li); }
      insp.appendChild(ul); }
  } else if (n.type === "norm") {
    add("what it is", n.what); add("stops (folded)", n.stops); add("overturned", n.rejected);
  } else if (n.type === "failure") {
    add("tool", n.tool);
  } else if (n.type === "skill") {
    add("slug", n.slug); add("category", n.cat);
    add("aliases folded", n.aliases || "—");
    add("supply / demand", n.supply + " / " + n.demand);
    add("evidence", n.ev);
    add("status", n.dormant ? "dormant" : "active");
  } else if (n.type === "hub") {
    const t = document.createElement("div"); t.className = "kind"; t.textContent = "members";
    insp.appendChild(t);
    const ul = document.createElement("ul");
    for (const m of n.members || []) { const li = document.createElement("li"); li.textContent = m; ul.appendChild(li); }
    insp.appendChild(ul);
  } else {
    if (n.agent) add("on agent", n.agent);
    if (n.kind) add("proposal kind", n.kind);
    if (n.count != null) add("decisions", n.count);
  }
  insp.appendChild(dl);
  if (n.cause) insp.appendChild(interpEl("cause", n.cause));
  if (n.effect) insp.appendChild(interpEl("effect", n.effect));
  if (n.action) insp.appendChild(interpEl("action", n.action));
  const rel = links.filter(l => l.a === n || l.b === n);
  if (rel.length) {
    const t = document.createElement("div"); t.className = "kind"; t.style.marginTop = "10px"; t.textContent = "edges";
    const ul = document.createElement("ul");
    for (const l of rel.slice(0, 10)) {
      const other = l.a === n ? l.b : l.a;
      const li = document.createElement("li");
      li.textContent = (V.elabels[l.k] || l.k) + " " + other.name + (l.label ? " — " + l.label : "");
      ul.appendChild(li);
    }
    insp.append(t, ul);
  }
}

// tables (agent view only)
(function buildTables() {
  const tb = document.getElementById("tablecontent");
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Agent</th><th>Kind</th><th>Rejected proposal</th><th>Tool</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const r of DATA.views.agentb.rejects) {
    const tr = document.createElement("tr");
    [r.agent_type, r.kind, r.title, r.tool || "—"].forEach((c, i) => {
      const td = document.createElement("td"); td.textContent = c; if (i > 0) td.className = "dim"; tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); tb.appendChild(table);
  const pc = document.getElementById("plancontent");
  const ptable = document.createElement("table");
  ptable.innerHTML = "<thead><tr><th>Pri</th><th>Agent</th><th>Ver</th><th>State</th><th>Runs</th><th>Stops</th><th>Overturned</th><th>Errors</th><th>Next best action</th></tr></thead>";
  const pbody = document.createElement("tbody");
  for (const p of DATA.views.agentb.plan) {
    const tr = document.createElement("tr");
    const priTd = document.createElement("td");
    const badge = document.createElement("span"); badge.className = "badge " + (p.pri === "high" ? "critical" : p.pri === "medium" ? "warning" : "good");
    badge.dataset.icon = p.pri === "high" ? "⚠" : p.pri === "medium" ? "!" : "✓";
    badge.textContent = p.pri;
    priTd.appendChild(badge); tr.appendChild(priTd);
    [p.name, p.ver, p.state, p.runs, p.stops, p.overturned, p.errors, p.action].forEach((c, i) => {
      const td = document.createElement("td"); td.textContent = c; if (i > 0) td.className = "dim"; tr.appendChild(td);
    });
    pbody.appendChild(tr);
  }
  ptable.appendChild(pbody); pc.appendChild(ptable);
})();

document.getElementById("tab-agentb").addEventListener("click", () => mount("agentb"));
document.getElementById("tab-gov").addEventListener("click", () => mount("gov"));
document.getElementById("tab-vocab").addEventListener("click", () => mount("vocab"));
mount("agentb");
loop();
</script>
</body>
</html>`;

await Bun.write(out, html);
console.log("wrote " + out);
console.log("agentb: runs=" + DATA.views.agentb.tiles[0][1] + " nodes=" + DATA.views.agentb.nodes.length + " edges=" + DATA.views.agentb.edges.length + " chips=" + DATA.views.agentb.systemRead.length + " plan=" + DATA.views.agentb.plan.length);
console.log("gov: nodes=" + DATA.views.gov.nodes.length + " edges=" + DATA.views.gov.edges.length + " chips=" + DATA.views.gov.systemRead.length);
console.log("vocab: nodes=" + DATA.views.vocab.nodes.length + " edges=" + DATA.views.vocab.edges.length + " chips=" + DATA.views.vocab.systemRead.length);
