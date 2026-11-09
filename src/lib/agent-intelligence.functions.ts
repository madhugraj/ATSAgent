/**
 * Agent Intelligence (org-scoped, governance roles only): the knowledge-graph
 * view of the hiring fleet — agents, person gates, decisions, vocabulary —
 * computed live from agent_runs / agent_steps / agent_tasks / stage_events and
 * raw skills. Three views per the analytics stack:
 *   behavior    — agents × person gates × vocabulary, candidates folded into edge counts
 *   governance  — every person decision, the norm it acted under, overturn chains
 *   vocabulary  — skills/role families seeded in-memory by the production buildOntology()
 * Deterministic: no model calls, no vendor or model names anywhere in the payload.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../server/db";
import { agentDefinitions, agentRuns, agentSteps, agentTasks, applications, candidates, departments, matchScores, requisitions, stageEvents } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { buildOntology } from "./ontology.server";

const GOVERNANCE_ROLES = ["hr_head", "president_cbo"] as const;

export type Pri = "high" | "medium" | "ok";

export type Chip = {
  pri: Pri;
  short: string;
  title: string;
  cause: string;
  effect: string;
  action: string;
};

export type GNode = {
  id: string;
  type: string;
  name: string;
  what?: string | undefined;
  runs?: number | undefined;
  steps?: number | undefined;
  avg?: number | undefined;
  ver?: string | undefined;
  stops?: number | undefined;
  rejected?: number | undefined;
  tool?: string | undefined;
  awaiting?: number | undefined;
  idle?: boolean | undefined;
  members?: string[] | undefined;
  agent?: string | undefined;
  kind?: string | undefined;
  count?: number | undefined;
  slug?: string | undefined;
  cat?: string | undefined;
  aliases?: string | undefined;
  supply?: number | undefined;
  demand?: number | undefined;
  ev?: number | undefined;
  dormant?: boolean | undefined;
  cause?: string | undefined;
  effect?: string | undefined;
  action?: string | undefined;
};

export type GEdge = { s: string; t: string; k: string; label?: string | undefined };

export type TypeStyle = { color: string; r: number; label: string; plural?: string };
export type EdgeStyle = { color: string; width: number; dash?: string; opacity?: number };

export type View = {
  key: "behavior" | "governance" | "vocabulary";
  title: string;
  snapshot: string;
  tiles: [string, string, string][];
  nodes: GNode[];
  edges: GEdge[];
  typeStyles: Record<string, TypeStyle>;
  edgeStyles: Record<string, EdgeStyle>;
  elabels: Record<string, string>;
  spring: Record<string, number>;
  systemRead: Chip[];
  sysreadSummary: string;
};

export type ActionPlanRow = {
  name: string;
  ver: string;
  state: string;
  pri: Pri;
  runs: number;
  stops: number;
  overturned: number;
  errors: number;
  awaiting: number;
  action: string;
};

export type RejectRow = { agentType: string; kind: string; title: string; tool: string | null; count: number };

export type AgentIntelligence = {
  generatedAt: string;
  views: {
    behavior: {
      tiles: [string, string, string][];
      nodes: GNode[];
      edges: GEdge[];
      systemRead: Chip[];
      sysreadSummary: string;
      plan: ActionPlanRow[];
      rejects: RejectRow[];
      fleet: { registered: number; idle: number; gap: number };
    };
    governance: {
      tiles: [string, string, string][];
      nodes: GNode[];
      edges: GEdge[];
      systemRead: Chip[];
      sysreadSummary: string;
    };
    vocabulary: {
      tiles: [string, string, string][];
      nodes: GNode[];
      edges: GEdge[];
      systemRead: Chip[];
      sysreadSummary: string;
      stats: { nodeCount: number; edgeCount: number; shown: number; folded: number };
    };
  };
};

const priOf = (t: string): Pri => (t.startsWith("⚠") ? "high" : t.startsWith("◈") ? "medium" : "ok");
const summarize = (chips: Chip[]) =>
  `${chips.filter((c) => c.pri === "high").length} need action · ${chips.filter((c) => c.pri === "medium").length} to plan · ${chips.filter((c) => c.pri === "ok").length} healthy`;

export const agentIntelligence = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<AgentIntelligence> => {
    const org = context.orgId;
    await assertRole(context.userId, org, [...GOVERNANCE_ROLES]);

    const [runsByAgent, runsByStatus, tasksByAgentKind, rejectDetails, errorClusters, awaitingByAgent, definitions, defChurn, openByAgent, taskTotals, stageActorRows, candRows, demandRows, orgCountRows, matchScoreRows] =
      await Promise.all([
        db
          .select({
            agentType: agentRuns.agentType,
            runs: agentRuns.id,
            steps: agentSteps.id,
          })
          .from(agentRuns)
          .leftJoin(agentSteps, eq(agentSteps.runId, agentRuns.id))
          .where(eq(agentRuns.orgId, org)),
        db.select({ status: agentRuns.status, n: agentRuns.id }).from(agentRuns).where(eq(agentRuns.orgId, org)),
        db
          .select({ agentType: agentRuns.agentType, kind: agentTasks.kind, status: agentTasks.status, n: agentTasks.id })
          .from(agentTasks)
          .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
          .where(eq(agentTasks.orgId, org)),
        db
          .select({
            agentType: agentRuns.agentType,
            kind: agentTasks.kind,
            title: agentTasks.title,
            tool: agentTasks.proposedAction,
          })
          .from(agentTasks)
          .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
          .where(and(eq(agentTasks.orgId, org), eq(agentTasks.status, "rejected"))),
        db
          .select({ agentType: agentRuns.agentType, tool: agentSteps.toolName, n: agentSteps.id })
          .from(agentSteps)
          .innerJoin(agentRuns, eq(agentRuns.id, agentSteps.runId))
          .where(and(eq(agentSteps.orgId, org), eq(agentSteps.status, "error"))),
        db
          .select({ agentType: agentRuns.agentType, n: agentRuns.id })
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, org), eq(agentRuns.status, "awaiting_human"))),
        db
          .select({ agentType: agentDefinitions.agentType, version: agentDefinitions.version })
          .from(agentDefinitions)
          .orderBy(desc(agentDefinitions.createdAt)),
        db.select({ agentType: agentDefinitions.agentType, hash: agentDefinitions.hash }).from(agentDefinitions),
        db
          .select({ agentType: agentRuns.agentType, n: agentTasks.id })
          .from(agentTasks)
          .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
          .where(and(eq(agentTasks.orgId, org), eq(agentTasks.status, "open"))),
        db.select({ status: agentTasks.status, n: agentTasks.id }).from(agentTasks).where(eq(agentTasks.orgId, org)),
        db.select({ actor: stageEvents.actor, n: stageEvents.id }).from(stageEvents).where(eq(stageEvents.orgId, org)),
        db
          .select({ id: candidates.id, skills: candidates.skills, createdAt: candidates.createdAt })
          .from(candidates)
          .where(eq(candidates.orgId, org)),
        db
          .select({
            id: requisitions.id,
            title: requisitions.title,
            openings: requisitions.openings,
            must: requisitions.mustHaveSkills,
            good: requisitions.goodToHaveSkills,
            status: requisitions.status,
            dept: departments.name,
          })
          .from(requisitions)
          .leftJoin(departments, eq(departments.id, requisitions.departmentId))
          .where(eq(requisitions.orgId, org)),
        db.select({ n: agentRuns.id }).from(agentRuns).where(eq(agentRuns.orgId, org)),
        db
          .select({ n: matchScores.id })
          .from(matchScores)
          .innerJoin(applications, eq(applications.id, matchScores.applicationId))
          .where(eq(applications.orgId, org)),
      ]);

    // fold join rows into aggregates in JS (counts stay exact, one round trip per table)
    const runsAgg = new Map<string, { runs: Set<string>; steps: number }>();
    for (const r of runsByAgent) {
      const e = runsAgg.get(r.agentType) ?? { runs: new Set<string>(), steps: 0 };
      e.runs.add(r.runs);
      if (r.steps) e.steps += 1;
      runsAgg.set(r.agentType, e);
    }
    const statusCount = new Map<string, number>();
    for (const r of runsByStatus) statusCount.set(r.status, (statusCount.get(r.status) ?? 0) + 1);
    const taskAgg = new Map<string, Map<string, Map<string, number>>>();
    for (const t of tasksByAgentKind) {
      const kinds = taskAgg.get(t.agentType) ?? new Map();
      const st = kinds.get(t.kind) ?? new Map<string, number>();
      st.set(t.status, (st.get(t.status) ?? 0) + 1);
      kinds.set(t.kind, st);
      taskAgg.set(t.agentType, kinds);
    }
    const taskTotal = (a: string, kind: string) => {
      const st = taskAgg.get(a)?.get(kind);
      return st ? [...st.values()].reduce((x, y) => x + y, 0) : 0;
    };
    const taskStat = (a: string, kind: string, s: string) => taskAgg.get(a)?.get(kind)?.get(s) ?? 0;
    const sumKind = (kind: string, status?: string) => {
      let n = 0;
      for (const kinds of taskAgg.values()) {
        const st = kinds.get(kind);
        if (!st) continue;
        n += status ? (st.get(status) ?? 0) : [...st.values()].reduce((x, y) => x + y, 0);
      }
      return n;
    };
    const rejectGroups = new Map<string, RejectRow>();
    for (const r of rejectDetails) {
      const row = {
        agentType: r.agentType,
        kind: r.kind,
        title: r.title.slice(0, 70),
        tool: ((r.tool as Record<string, unknown> | null)?.["name"] as string | null) ?? null,
      };
      const key = `${row.agentType}|${row.kind}|${row.title}|${row.tool ?? ""}`;
      const g = rejectGroups.get(key);
      if (g) g.count += 1;
      else rejectGroups.set(key, { ...row, count: 1 });
    }
    const rejectRows: RejectRow[] = [...rejectGroups.values()].sort((a, b) => b.count - a.count);
    const errByAgent = new Map<string, Map<string, number>>();
    for (const e of errorClusters) {
      if (!e.tool) continue;
      const m = errByAgent.get(e.agentType) ?? new Map<string, number>();
      m.set(e.tool, (m.get(e.tool) ?? 0) + 1);
      errByAgent.set(e.agentType, m);
    }
    const errByTool = new Map<string, number>();
    for (const [, m] of errByAgent) for (const [tool, n] of m) errByTool.set(tool, (errByTool.get(tool) ?? 0) + n);
    const awaitingMap = new Map<string, number>();
    for (const r of awaitingByAgent) awaitingMap.set(r.agentType, (awaitingMap.get(r.agentType) ?? 0) + 1);
    const openMap = new Map<string, number>();
    for (const r of openByAgent) openMap.set(r.agentType, (openMap.get(r.agentType) ?? 0) + 1);
    const churn = new Map<string, number>();
    for (const r of defChurn) churn.set(r.agentType, (churn.get(r.agentType) ?? 0) + 1);
    const defVersions = new Map<string, string>();
    // rows arrive newest-first; prefer the newest released version over eval/test manifests
    const isPrerelease = (v: string) => /-(eval|test)/.test(v);
    for (const r of definitions) {
      const cur = defVersions.get(r.agentType);
      if (cur === undefined || (isPrerelease(cur) && !isPrerelease(r.version))) defVersions.set(r.agentType, r.version);
    }
    const registered = [...new Set(definitions.map((d) => d.agentType))].sort();
    const taskStatus = { cancelled: 0, answered: 0, open: 0 };
    for (const r of taskTotals) if (r.status in taskStatus) taskStatus[r.status as keyof typeof taskStatus] += 1;
    const stageTotal = stageActorRows.length;
    const aiMoves = stageActorRows.filter((r) => r.actor === "ai").length;

    const totalRuns = [...runsAgg.values()].reduce((s, e) => s + e.runs.size, 0);
    const totalSteps = [...runsAgg.values()].reduce((s, e) => s + e.steps, 0);
    const awaiting = statusCount.get("awaiting_human") ?? 0;
    const failed = statusCount.get("failed") ?? 0;
    const cancelledRuns = statusCount.get("cancelled") ?? 0;
    const approvals = sumKind("approval");
    const approvalsRejected = sumKind("approval", "rejected");
    const gates = sumKind("gate");
    const gatesRejected = sumKind("gate", "rejected");
    const clarifications = sumKind("clarification");
    const statMap = new Map(
      [...runsAgg.entries()].map(([a, e]) => [a, { runs: e.runs.size, steps: e.steps, avg: Math.round((e.steps / Math.max(e.runs.size, 1)) * 10) / 10 }]),
    );

    const norm = {
      hitl: { stops: approvals, rejected: approvalsRejected },
      gates: { stops: gates, rejected: gatesRejected },
      clarify: { stops: clarifications, rejected: 0 },
    };

    const matchScoresCount = matchScoreRows.length;

    // ---------------- behavior view ----------------
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    const idleAgents: string[] = [];
    const gapAgents: string[] = [];
    for (const a of registered) {
      const st = statMap.get(a);
      if (!st) {
        idleAgents.push(a);
        nodes.push({
          id: `ag-${a}`, type: "agent", name: a, ver: defVersions.get(a), runs: 0, steps: 0, avg: 0, awaiting: 0, idle: true,
          cause: `Registered in the manifest (v${defVersions.get(a) ?? "?"}) with zero runs this period.`,
          effect: `The capability exists but nobody invokes it — dead weight in governance, evals and cost accounting, or an unadopted feature.`,
          action: `Decide: enable it (a tick, a copilot route, a client feature flag) or park it. An agent that never runs should not silently keep its manifest.`,
        });
        edges.push({ s: `ag-${a}`, t: "hub-idle", k: "idle", label: "0 runs" });
        continue;
      }
      const appT = taskTotal(a, "approval");
      const appR = taskStat(a, "approval", "rejected");
      const gateT = taskTotal(a, "gate");
      const gateR = taskStat(a, "gate", "rejected");
      const cla = taskTotal(a, "clarification");
      const err = errByAgent.get(a) ? [...errByAgent.get(a)!.values()].reduce((x, y) => x + y, 0) : 0;
      const n: GNode = {
        id: `ag-${a}`, type: "agent", name: a, ver: defVersions.get(a),
        runs: st.runs, steps: st.steps, avg: st.avg, awaiting: awaitingMap.get(a) ?? 0,
      };
      if (appR >= 2 && appT > 0 && appR / Math.max(appT, 1) >= 0.1) {
        n.cause = `Persons rejected ${appR} of ${appT} approval proposals (${Math.round((appR / appT) * 100)}%) — mostly "${rejectRows.find((x) => x.agentType === a)?.title ?? "proposed action"}".`;
        n.effect = `The agent's judgment of "who to advance" is out of sync with the people reviewing it.`;
        n.action = `Read the rejection reasons in the decisions inbox; either the scorer's threshold or the proposal wording needs to change — not the reviewer.`;
      } else if (appT + gateT + cla > 0) {
        n.cause = `${appT + gateT + cla} person touchpoints (${appT} approvals, ${gateT} gates, ${cla} clarifications); ${appR + gateR} declined.`;
        n.effect = `Overturn rate ${Math.round(((appR + gateR) / Math.max(appT + gateT, 1)) * 100)}% — inside the healthy band (< 10%).`;
        n.action = `None — keep the 10% health threshold so drift surfaces on its own.`;
      } else if (st.steps > 0) {
        n.cause = `${st.runs} runs · ${st.steps} steps, all autonomous (no person touchpoints).`;
        n.effect = err > 0 ? `${err} tool errors — see the failure cluster.` : `Clean: no errors, no interventions.`;
        n.action = err > 5 ? `Investigate the failing tool before trusting the output.` : `None.`;
      } else {
        gapAgents.push(a);
        n.cause = `${st.runs} runs with no agent steps (voice/panel sessions — captured outside agent_steps).`;
        n.effect = `Behavior lives in call transcripts, not the step trace — these agents are invisible to every step-based governance rule.`;
        n.action = `Add session-shaped telemetry (turns, consent, tool calls) so voice/panel behavior joins the graph and its health rules.`;
        edges.push({ s: `ag-${a}`, t: "hub-gap", k: "gap", label: `×${st.runs} runs, 0 steps` });
      }
      if (err >= 5 && n.action && !n.action.includes("Top failure")) {
        const top = [...(errByAgent.get(a) ?? new Map<string, number>())].sort((x, y) => y[1] - x[1])[0];
        if (top) n.action = n.action.startsWith("None") ? `Investigate top failure ${top[0]} ×${top[1]}.` : `${n.action} Top failure: ${top[0]} ×${top[1]}.`;
      }
      nodes.push(n);
      if (appT > 0) edges.push({ s: `ag-${a}`, t: "n-hitl", k: "gated", label: appR ? `×${appT}, ${appR} rejected` : undefined });
      if (gateT > 0) edges.push({ s: `ag-${a}`, t: "n-gates", k: "gated", label: gateR ? `×${gateT}, ${gateR} rejected` : undefined });
      if (cla > 0) edges.push({ s: `ag-${a}`, t: "n-clarify", k: "gated", label: `×${cla}` });
      for (const [tool, cnt] of errByAgent.get(a) ?? []) {
        if (cnt >= 3) edges.push({ s: `ag-${a}`, t: `fail-${tool}`, k: "errored", label: `×${cnt}` });
      }
    }

    if (idleAgents.length)
      nodes.push({
        id: "hub-idle", type: "hub", name: `${idleAgents.length} agents not used yet`, members: idleAgents,
        cause: `${idleAgents.length} of ${registered.length} registered agents ran zero times: ${idleAgents.join(", ")}.`,
        effect: `Copilot — the routing front door — is among them: requests reach specialists directly, so routing and its guardrails are untested.`,
        action: `Per agent: enable (tick, copilot route, feature flag) or park. An idle manifest should be a decision, not an accident.`,
      });
    if (gapAgents.length)
      nodes.push({
        id: "hub-gap", type: "hub", name: `${gapAgents.length} call agents (no step trace)`, members: gapAgents,
        cause: `${gapAgents.join(", ")} ran with zero rows in agent_steps — voice/panel sessions are captured out-of-band.`,
        effect: `These agents bypass every step-based rule: error clusters, run limits on tools, and this graph.`,
        action: `Emit session turns as steps (consent, tool calls, outcomes) — until then, treat their transcripts as unaudited.`,
      });

    const normSpecs = [
      { id: "n-hitl", name: "Approval cards", what: "proposed actions wait for a person (shortlist, feed listing…)", stops: norm.hitl.stops, rejected: norm.hitl.rejected },
      { id: "n-gates", name: "Sign-off gates", what: "requisition/org-profile/jd approvals before any publish", stops: norm.gates.stops, rejected: norm.gates.rejected },
      { id: "n-clarify", name: "Questions to a person", what: "agent asks, a person answers (ask_human)", stops: norm.clarify.stops, rejected: 0 },
    ];
    for (const s of normSpecs) {
      nodes.push({
        ...s, type: "norm",
        cause: `${s.what}. ${s.stops} stops folded from ${totalRuns} runs.`,
        effect: s.rejected > 0 ? `${s.rejected} overturned by a person (${Math.round((s.rejected / Math.max(s.stops, 1)) * 100)}%) — the miscalibration signal.` : `Zero overturns — calibrated.`,
        action: s.rejected >= 3 ? `This norm (or the proposals under it) needs review — see the rejected chains.` : `None.`,
      });
    }
    for (const [tool, count] of errByTool) {
      if (count < 3) continue;
      const parts = [...errByAgent.entries()].filter(([, m]) => m.get(tool)).map(([a, m]) => `${a} ×${m.get(tool)}`).join(" + ");
      nodes.push({
        id: `fail-${tool}`, type: "failure", name: tool, tool,
        cause: `${count} errors inside agent runs — ${parts}.`,
        effect: tool === "add_to_pipeline"
          ? `Duplicate-pipeline skips — the skip-already-in-pipeline fix should retire most of these; verify on the next run.`
          : tool === "read_org_website"
            ? `Failure rate this high on the tool the org profile is built from — network egress or parser sandbox, not the model.`
            : `Repeated tool failure — flaky dependency or bad input shape.`,
        action: tool === "add_to_pipeline"
          ? `Re-run an intake stretch and confirm the error count drops.`
          : tool === "read_org_website"
            ? `Check egress rules / parser sandbox health; this is infrastructure, not intelligence.`
            : `Inspect last_error on the steps.`,
      });
    }

    const behaviorChips: Chip[] = [];
    const webErr = [...errByTool.entries()].find(([t]) => t === "read_org_website");
    if (webErr && webErr[1] >= 10)
      behaviorChips.push({
        pri: "high", title: `⚠ org-site reads fail at scale (${webErr[1]} errors)`, short: `org-site reads failing ×${webErr[1]}`,
        cause: `${webErr[1]} of org_context's website reads errored — that is most of its read attempts, and it is the tool the org profile is built from.`,
        effect: `Org profiles may be silently thinner than they look; every downstream agent consumes them.`,
        action: `Check egress/parser-sandbox health first (infrastructure, not model). Then re-run an org_context stretch and compare profile depth.`,
      });
    const dupErr = [...errByTool.entries()].find(([t]) => t === "add_to_pipeline");
    if (dupErr && dupErr[1] >= 5)
      behaviorChips.push({
        pri: "high", title: `⚠ add_to_pipeline errors (${dupErr[1]} across agents)`, short: `pipeline dup errors ×${dupErr[1]}`,
        cause: `Duplicate-pipeline rejections across agents — retries waste run budget.`,
        effect: `After the skip-already-in-pipeline fix these should collapse.`,
        action: `Re-run an intake stretch and verify the count drops; if it doesn't, the fix regressed.`,
      });
    if (approvalsRejected >= 2) {
      const intakeR = taskStat("intake", "approval", "rejected");
      behaviorChips.push({
        pri: "high", title: `⚠ Persons are rejecting agent proposals (${approvalsRejected} overturns)`,
        short: `${approvalsRejected} of ${approvals} proposals declined (${Math.round((approvalsRejected / Math.max(approvals, 1)) * 100)}%)`,
        cause: intakeR >= 2 ? `Intake's proposals were declined ${intakeR}× — mostly "${rejectRows.find((x) => x.agentType === "intake")?.title ?? "proposed action"}".` : `Rejections across ${new Set(rejectRows.map((r) => r.agentType)).size} agents.`,
        effect: `Overturn rate on HITL cards: ${Math.round((approvalsRejected / Math.max(approvals, 1)) * 100)}%. The agent's judgment and the reviewer's disagree.`,
        action: `Read the rejection reasons. If the wording is the problem, change the proposal copy; if the candidates are, change the scorer threshold. Don't touch the reviewer.`,
      });
    }
    if (idleAgents.includes("copilot"))
      behaviorChips.push({
        pri: "medium", title: `◈ The front door never opened — copilot has 0 runs`,
        short: `copilot never invoked — routing untested`,
        cause: `All ${totalRuns} runs reached specialists directly; the routing layer and its confirmations were never exercised.`,
        effect: `The one agent designed to gate which specialist acts is the least-tested one.`,
        action: `Drive one stretch of work through the copilot deliberately, or accept direct routing as the real UX and re-scope the copilot.`,
      });
    if (gapAgents.length)
      behaviorChips.push({
        pri: "medium", title: `◈ ${gapAgents.join(", ")} run out-of-band — invisible to the step trace`,
        short: `${gapAgents.join(", ")}: runs with 0 steps`,
        cause: `Voice/panel sessions are captured in transcripts, not agent_steps.`,
        effect: `These agents bypass every step-based rule and this graph.`,
        action: `Emit session turns as steps so governance covers them.`,
      });
    const failRate = failed / Math.max(totalRuns, 1);
    behaviorChips.push({
      pri: failRate >= 0.1 ? "medium" : "ok",
      title: failRate >= 0.1
        ? `◈ ${failed} of ${totalRuns} runs failed (${Math.round(failRate * 100)}%) — ${awaiting} await a person`
        : `✓ The fleet is quiet — ${awaiting} runs await a person, ${failed} failed`,
      short: failRate >= 0.1 ? `${failed}/${totalRuns} runs failed · ${awaiting} awaiting` : `fleet quiet — ${awaiting} awaiting, ${failed} failed`,
      cause: `${totalRuns} runs · ${totalSteps} steps · ${failed} failed · ${cancelledRuns} cancelled.`,
      effect: `Gate stops (${norm.hitl.stops + norm.gates.stops}) behaved as designed.`,
      action: `Cancelled runs (${cancelledRuns}) are stale ticks — harmless, but a liveness rule could reap them sooner.`,
    });
    behaviorChips.push({
      pri: "medium", title: `◈ Fleet coverage: ${registered.length - idleAgents.length}/${registered.length} agents active, ${idleAgents.length} idle`,
      short: `coverage ${registered.length - idleAgents.length}/${registered.length} active · ${idleAgents.length} idle`,
      cause: `${idleAgents.length} agents have manifests but no runs.`,
      effect: `Governance coverage is ${Math.round(((registered.length - idleAgents.length - gapAgents.length) / Math.max(registered.length, 1)) * 100)}% of the fleet.`,
      action: `The Action plan table has the per-agent decision; make idle a decision, and pull voice sessions into the trace.`,
    });
    const behaviorSysread = behaviorChips.map((c) => ({ ...c, pri: priOf(c.title) }));
    behaviorChips.sort((a, b) => a.pri.localeCompare(b.pri));

    const plan: ActionPlanRow[] = [];
    for (const a of registered) {
      const st = statMap.get(a);
      const ver = defVersions.get(a) ?? "?";
      if (!st) {
        plan.push({ name: a, ver, state: "idle", pri: "ok", runs: 0, stops: 0, overturned: 0, errors: 0, awaiting: 0, action: `Not used yet — turn it on in Agent settings if you expect it to work for you; otherwise no action.` });
        continue;
      }
      const appT = taskTotal(a, "approval"), appR = taskStat(a, "approval", "rejected");
      const gateT = taskTotal(a, "gate"), gateR = taskStat(a, "gate", "rejected");
      const cla = taskTotal(a, "clarification");
      const errors = errByAgent.get(a) ? [...errByAgent.get(a)!.values()].reduce((x, y) => x + y, 0) : 0;
      const awaitingN = awaitingMap.get(a) ?? 0;
      const stops = appT + gateT + cla;
      const overturned = appR + gateR;
      let state: string, pri: Pri, action: string;
      if (st.steps === 0) {
        state = "no trace"; pri = "medium";
        action = `Runs as a live call — review its call transcripts; step-level governance does not cover it yet.`;
      } else if (overturned >= 2 && stops > 0) {
        state = "out of sync"; pri = "high";
        action = `Persons declined ${overturned} of ${stops} proposals — read the rejection reasons; fix proposal copy or scorer threshold, not the reviewer.`;
      } else if (errors >= 10) {
        const top = [...(errByAgent.get(a) ?? new Map<string, number>())].sort((x, y) => y[1] - x[1])[0];
        state = "failing"; pri = "high";
        action = `${errors} failed tool calls${top ? ` — mostly ${top[0]} ×${top[1]}` : ""}. Ask your admin to check that step before relying on this agent's output.`;
      } else if (errors >= 3) {
        state = "flaky"; pri = "medium";
        action = `${errors} failed tool calls — watch the next runs; escalate if the count keeps rising.`;
      } else if (awaitingN > 0) {
        state = "waiting"; pri = "medium";
        action = `${awaitingN} run(s) parked awaiting a person — clear the decisions inbox.`;
      } else if (stops > 0) {
        state = "healthy"; pri = "ok";
        action = `None — ${stops} touchpoints, overturn rate inside band.`;
      } else {
        state = "clean"; pri = "ok";
        action = errors > 0 ? `None — ${errors} isolated failed call(s), below the alert threshold.` : `None — autonomous, no errors, no interventions.`;
      }
      plan.push({ name: a, ver, state, pri, runs: st.runs, stops, overturned, errors, awaiting: awaitingN, action });
    }
    const priOrder = { high: 0, medium: 1, ok: 2 } as const;
    plan.sort((x, y) => priOrder[x.pri] - priOrder[y.pri] || y.errors - x.errors || x.name.localeCompare(y.name));

    // ---------------- governance view ----------------
    const govNodes: GNode[] = [];
    const govEdges: GEdge[] = [];
    const kindNorm: Record<string, string> = { approval: "n-hitl", gate: "n-gates", clarification: "n-clarify" };
    const kindWord: Record<string, string> = { approval: "cards", gate: "gates", clarification: "asks" };
    let govOk = 0, govRej = 0, govAnswered = 0;
    const govSeen = new Set<string>();
    for (const [agent, kinds] of taskAgg) {
      for (const [kind, st] of kinds) {
        const ok = (st.get("approved") ?? 0) + (st.get("answered") ?? 0);
        const rej = st.get("rejected") ?? 0;
        if (!ok && !rej) continue;
        govSeen.add(kind);
        govOk += st.get("approved") ?? 0;
        govAnswered += st.get("answered") ?? 0;
        govRej += rej;
        const nk: string = kindNorm[kind] ?? "";
        if (ok > 0) {
          govNodes.push({
            id: `gv-ok-${agent}-${kind}`, type: "dOk", name: `✓ ${kindWord[kind]} · ${agent}`, agent, kind, count: ok,
            cause: `${ok} proposals approved by a person (${kindWord[kind]} on ${agent} runs).`,
            effect: `Human-in-the-loop working as designed on this proposal type.`,
            action: `None — approved decisions are the calibration baseline.`,
          });
          govEdges.push({ s: `gv-ok-${agent}-${kind}`, t: nk, k: "decided" });
        }
        if (rej > 0) {
          const titles = rejectRows.filter((d) => d.agentType === agent && d.kind === kind).map((d) => `${d.title} (${d.tool ?? "?"})`);
          govNodes.push({
            id: `gv-rej-${agent}-${kind}`, type: "dBad", name: `✗ ${kindWord[kind]} · ${agent}`, agent, kind, count: rej, members: titles,
            cause: `${rej} proposal(s) declined by a person: ${titles.join("; ")}.`,
            effect: rej >= 2
              ? `The same proposal type keeps getting declined — the agent's judgment or its wording is out of sync with reviewers.`
              : `A single rejection is normal human disagreement — it becomes a pattern at 2.`,
            action: rej >= 2 ? `Read the rejection reasons; fix proposal copy or scorer threshold, not the reviewer.` : `No action yet.`,
          });
          govEdges.push({ s: `gv-rej-${agent}-${kind}`, t: nk, k: "decided" });
        }
      }
    }
    for (const s of normSpecs) {
      const kindKey = s.id === "n-hitl" ? "approval" : s.id === "n-gates" ? "gate" : "clarification";
      if (!govSeen.has(kindKey)) continue;
      govNodes.push({
        ...s, type: "norm",
        cause: `${s.what}.`,
        effect: s.rejected > 0 ? `${s.rejected} overturns against ${s.stops} stops.` : `${s.stops} stops, zero overturns — calibrated.`,
        action: s.rejected >= 3 ? `Review the proposals under this norm — see the rejected chains.` : `None.`,
      });
    }
    if (taskStatus.open > 0)
      govNodes.push({
        id: "gv-open", type: "dOpen", name: `open cards ×${taskStatus.open}`, members: [...openMap.keys()],
        cause: `${taskStatus.open} cards still awaiting a person: ${[...openMap.entries()].map(([a, c]) => `${a} ×${c}`).join(", ")}.`,
        effect: `Proposals (and the runs behind them) are parked mid-flight; ${awaiting} runs sit in awaiting_human.`,
        action: `Clear the decisions inbox — oldest cards first.`,
      });
    if (taskStatus.cancelled > 0)
      govNodes.push({
        id: "gv-cancel", type: "dMut", name: `cancelled ×${taskStatus.cancelled}`,
        cause: `${taskStatus.cancelled} cards were cancelled — mostly stale ticks reaped when their run ended.`,
        effect: `Harmless, but they bury the live signals in the decisions inbox.`,
        action: `A liveness rule should cancel stale cards sooner and mark them, so open ≠ stale.`,
      });

    const govChips: Chip[] = [];
    const repeatRej = govNodes.filter((n) => n.type === "dBad" && (n.count ?? 0) >= 2).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
    if (repeatRej)
      govChips.push({
        pri: "high", title: `⚠ Repeated overturns: ${repeatRej.agent} ${kindWord[repeatRej.kind!]} declined ×${repeatRej.count}`,
        short: `${repeatRej.agent} ${repeatRej.kind} declined ×${repeatRej.count}`,
        cause: (repeatRej.members ?? []).join("; "),
        effect: `The chain ${repeatRej.agent} → ${repeatRej.kind} → person keeps ending in "no" — a calibration defect, not a disagreement.`,
        action: `Read the rejection reasons; fix the proposal copy or the threshold. The reviewer is the ground truth here.`,
      });
    if (stageTotal > 0 && aiMoves / stageTotal >= 0.5) {
      const pct = Math.round((aiMoves / stageTotal) * 100);
      govChips.push({
        pri: "medium", title: `◈ Autonomy check: ai moves ${pct}% of pipeline transitions (${aiMoves}/${stageTotal})`,
        short: `ai moves ${pct}% of stage transitions`,
        cause: `stage_events actor field: ai ×${aiMoves}; person-via-agent ×${stageTotal - aiMoves}.`,
        effect: `The autonomy dial may say one thing while the pipeline says another — candidate progression is almost entirely model-driven.`,
        action: `Decide per transition whether ai-driven is intended (ai_screened: probably yes; shortlisted: maybe not) — encode it in the autonomy dial, not in convention.`,
      });
    }
    if (taskStatus.open > 0)
      govChips.push({
        pri: "high", title: `⚠ ${taskStatus.open} decision cards open — work is parked`,
        short: `${taskStatus.open} cards open — clear the inbox`,
        cause: `Open proposals: ${[...openMap.entries()].map(([a, c]) => `${a} ×${c}`).join(", ")}.`,
        effect: `Each open card holds its run in awaiting_human; candidates behind them age in place.`,
        action: `Clear the inbox oldest-first; then add a health rule for card age (e.g. >48h → escalation).`,
      });
    if (taskStatus.cancelled > 0)
      govChips.push({
        pri: "medium", title: `◈ ${taskStatus.cancelled} cancelled cards bury the live ones`,
        short: `${taskStatus.cancelled} cancelled cards — reap stale`,
        cause: `Cancelled cards are mostly stale ticks whose runs ended.`,
        effect: `They add noise to every decisions inbox and to this graph's denominators.`,
        action: `Liveness rule: cancel + mark stale cards early instead of at run end.`,
      });
    {
      const totalVersions = [...churn.values()].reduce((s, n) => s + n, 0);
      const top = [...churn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} ×${n}`).join(", ");
      govChips.push({
        pri: "medium", title: `◈ Definition churn: ${totalVersions} manifest versions — top ${top || "—"}`,
        short: `${totalVersions} definition versions — eval coverage per bump?`,
        cause: `Rapid iteration; ${top} lead the fleet.`,
        effect: `Every version bump changes behavior; without an eval per version, regressions ship silently.`,
        action: `Keep agents.lock + the eval gate strict: no version without an eval — the lock file is the enforcement point.`,
      });
    }
    govChips.push({
      pri: "ok", title: `✓ Calibration baseline: ${govOk + govAnswered} approved vs ${govRej} declined`,
      short: `${govOk + govAnswered}✓ / ${govRej}✗ — baseline recorded`,
      cause: `Every terminal person decision is on the governance graph with its norm.`,
      effect: `Overturn rate ${Math.round((govRej / Math.max(govOk + govRej, 1)) * 100)}% — this ratio is the fleet's calibration curve over time.`,
      action: `Track it per week; a rising curve is the earliest signal that agents and reviewers are drifting apart.`,
    });
    const govSysread = govChips.map((c) => ({ ...c, pri: priOf(c.title) }));

    // ---------------- vocabulary view (in-memory seed via the production normalizer) ----------------
    const ont = buildOntology({
      candidates: candRows.map((c) => ({
        candidateId: c.id,
        skills: c.skills ?? [],
        observedAt: c.createdAt.toISOString(),
        hired: false,
        resumeText: null,
      })),
      demand: demandRows.map((r) => ({
        requisitionId: r.id, title: r.title ?? "requisition", openings: r.openings ?? 1,
        mustHave: (r.must as string[] | null) ?? [], goodToHave: (r.good as string[] | null) ?? [], open: r.status !== "closed",
      })),
      previous: [],
    });
    const rawForms = new Set<string>();
    for (const c of candRows) for (const s of c.skills ?? []) rawForms.add(s.toLowerCase().trim());
    for (const r of demandRows)
      for (const s of ((r.must as string[] | null) ?? []).concat((r.good as string[] | null) ?? [])) rawForms.add(s.toLowerCase().trim());

    const allVocab: GNode[] = ont.nodes.map((n) => ({
      id: `sk-${n.slug}`, type: "skill", name: n.name, slug: n.slug, cat: n.category,
      aliases: n.aliases.join(", "), supply: n.supply, demand: n.demand, ev: n.evidence, dormant: n.status === "dormant",
      cause: `${n.evidence} evidence links · supply ${n.supply} / demand ${n.demand} · ${n.category}${n.aliases.length ? ` · aliases folded: ${n.aliases.join(", ")}` : ""}.`,
      effect: n.demand > 0 && n.supply === 0
        ? `Demanded with zero pool supply — every open req on this skill depends on sourcing.`
        : n.status === "dormant" ? `No recent evidence — flagged dormant by the build.` : `Active node, normal flow.`,
      action: n.demand > 0 && n.supply === 0 ? `Open a sourcing campaign or demote it to good-to-have.` : `None.`,
    }));
    const significant = allVocab
      .filter((n) => (n.demand ?? 0) > 0 || (n.ev ?? 0) >= 2)
      .sort((a, b) => (b.demand ?? 0) - (a.demand ?? 0) || (b.ev ?? 0) - (a.ev ?? 0));
    const shownSkills = significant.slice(0, 60);
    const minorCount = allVocab.length - shownSkills.length;
    const shownIds = new Set(shownSkills.map((n) => n.id));
    const vocabNodes: GNode[] = [...shownSkills];
    const vocabEdges: GEdge[] = [];
    for (const e of ont.edges.filter((e) => e.count >= 2).sort((a, b) => b.count - a.count).slice(0, 22)) {
      if (shownIds.has(`sk-${e.from}`) && shownIds.has(`sk-${e.to}`))
        vocabEdges.push({ s: `sk-${e.from}`, t: `sk-${e.to}`, k: "cooccurs", label: e.count >= 3 ? `×${e.count}` : undefined });
    }
    const deptAsks = new Map<string, Map<string, number>>();
    for (const r of demandRows) {
      if (!r.dept) continue;
      const m = deptAsks.get(r.dept) ?? new Map<string, number>();
      for (const s of (r.must as string[] | null) ?? []) m.set(s.toLowerCase().trim(), (m.get(s.toLowerCase().trim()) ?? 0) + 1);
      deptAsks.set(r.dept, m);
    }
    const slugOf = (raw: string) => {
      const hit = ont.nodes.find((n) => n.aliases.includes(raw) || n.name === raw || n.slug === raw.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      return hit ? hit.slug : null;
    };
    for (const [dept, m] of deptAsks) {
      const fid = `fam-${dept.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      vocabNodes.push({
        id: fid, type: "family", name: dept,
        cause: `Department standing in as a role family — ${[...m.values()].reduce((s, n) => s + n, 0)} must-have asks.`,
        effect: `${m.size} distinct skills demanded by this family.`,
        action: `Real role-family nodes (with builds_on) arrive with Phase 1; today departments are the proxy.`,
      });
      for (const [raw, n] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        const slug = slugOf(raw) ?? raw.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if (shownIds.has(`sk-${slug}`)) vocabEdges.push({ s: fid, t: `sk-${slug}`, k: "asks_for", label: n > 1 ? `×${n}` : undefined });
      }
    }
    const vocabChips: Chip[] = ont.insights.map((ins) => ({
      pri: (ins.severity === "high" ? "high" : ins.severity === "medium" ? "medium" : "ok") as Pri,
      title: `${ins.severity === "high" ? "⚠" : "◈"} ${ins.kind}: ${ins.title}`,
      short: ins.title,
      cause: `deriveInsights over ${ont.stats.candidates} candidates / ${ont.stats.requisitions} requisitions · skills: ${ins.skills.join(", ") || "—"}`,
      effect: ins.detail,
      action: ins.actionLabel ? `${ins.actionLabel} — route ${ins.actionTo}` : ins.detail,
    }));
    vocabChips.push({
      pri: "medium", title: `◈ Alias fold: ${rawForms.size} raw skill forms resolve to ${ont.nodes.length} nodes`,
      short: `${rawForms.size} raw forms → ${ont.nodes.length} nodes`,
      cause: `Every variant fold comes from the hardcoded alias table in ontology.server.ts — it learned nothing by itself.`,
      effect: `A form the table misses becomes a spurious node; this count is the alias table's report card.`,
      action: `Phase 1 replaces the hardcoded table with evidence-folded aliases (skillEvidence → alias learning).`,
    });
    vocabChips.push({
      pri: "medium", title: `◈ skill_nodes is still empty — this view is computed in-memory, not persisted`,
      short: `seed only — nothing persisted yet`,
      cause: `The nodes on this graph were built by the production buildOntology() from raw text[] columns at request time.`,
      effect: `Nothing is stored, so no agent can query this vocabulary yet.`,
      action: `Phase 1 persists these same nodes into skill_nodes/skill_edges — after that, agents query them through the deterministic layer.`,
    });
    vocabChips.push({
      pri: "ok", title: `◈ ${minorCount} low-evidence skills folded out of the graph`,
      short: `${minorCount} single-evidence skills hidden`,
      cause: `Skills with one evidence link, no demand and no aliases are real but insignificant.`,
      effect: `They still count in node totals and surface as evidence accumulates.`,
      action: `Thresholds stay: demand > 0 or evidence ≥ 2 puts a skill on the graph.`,
    });
    const vocabSysread = vocabChips.map((c) => ({ ...c, pri: priOf(c.title) })).sort((a, b) => priOrder[a.pri] - priOrder[b.pri]);

    return {
      generatedAt: new Date().toISOString(),
      views: {
        behavior: {
          tiles: [
            ["Runs", String(totalRuns), `${failed} failed · ${cancelledRuns} cancelled`],
            ["Agent steps", String(totalSteps), `${registered.length - idleAgents.length}/${registered.length} registered agents active`],
            ["Person touchpoints", String(norm.hitl.stops + norm.gates.stops + norm.clarify.stops), `${approvalsRejected + gatesRejected} declined · ${taskStatus.open} still open`],
            ["Match scores", String(matchScoresCount), "candidates scored against requisitions"],
          ],
          nodes, edges,
          systemRead: behaviorSysread.map((c) => ({ ...c, pri: priOf(c.title) })).sort((a, b) => priOrder[a.pri] - priOrder[b.pri]),
          sysreadSummary: summarize(behaviorSysread),
          plan, rejects: rejectRows,
          fleet: { registered: registered.length, idle: idleAgents.length, gap: gapAgents.length },
        },
        governance: {
          tiles: [
            ["Person decisions", String(govOk + govAnswered + govRej), `${govOk} approved · ${govRej} declined · ${govAnswered} answered`],
            ["Open cards", String(taskStatus.open), [...openMap.entries()].map(([a, c]) => `${a} ×${c}`).slice(0, 3).join(", ") || "none"],
            ["Cancelled cards", String(taskStatus.cancelled), "stale — reap with a liveness rule"],
            ["Stage moves", String(stageTotal), `${Math.round((aiMoves / Math.max(stageTotal, 1)) * 100)}% ai · ${stageTotal - aiMoves} person (via agent)`],
          ],
          nodes: govNodes, edges: govEdges,
          systemRead: govSysread,
          sysreadSummary: summarize(govSysread),
        },
        vocabulary: {
          tiles: [
            ["Skill nodes", String(ont.stats.nodeCount), `${vocabNodes.filter((n) => n.type === "skill").length} shown · ${minorCount} low-evidence folded`],
            ["Co-occurrence edges", String(ont.stats.edgeCount), `${vocabEdges.filter((e) => e.k === "cooccurs").length} shown (top by count)`],
            ["Insights", String(ont.insights.length), `${ont.insights.filter((i) => i.severity === "high").length} high severity`],
            ["Persisted", "0 rows", "skill_nodes empty — Phase 1 persists these"],
          ],
          nodes: vocabNodes, edges: vocabEdges,
          systemRead: vocabSysread,
          sysreadSummary: summarize(vocabSysread),
          stats: { nodeCount: ont.stats.nodeCount, edgeCount: ont.stats.edgeCount, shown: shownSkills.length, folded: minorCount },
        },
      },
    };
  });
