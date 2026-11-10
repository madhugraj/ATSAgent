/**
 * Agent intelligence (org-scoped, governance roles only): how the hiring
 * agents behave — which agents ran, the person checkpoints they passed, where
 * people declined their proposals and which tools failed — computed live from
 * agent_runs / agent_steps / agent_tasks. Harness governance lives in
 * agent-governance.functions.ts; skill supply vs demand in
 * skill-supply.functions.ts. Deterministic: no model calls, no vendor or model
 * names anywhere in the payload.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gte, lte } from "drizzle-orm";

import { db } from "../server/db";
import {
  agentDefinitions,
  agentRuns,
  agentSteps,
  agentTasks,
  applications,
  matchScores,
  stageEvents,
} from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { matchesModality, type ModalityFilter } from "./agent-modality";
import { reportWindowSchema, resolveWindow } from "./report-window";
import { modalityWhere } from "../server/agents/modality.server";

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

export type RejectRow = {
  agentType: string;
  kind: string;
  title: string;
  tool: string | null;
  count: number;
};

export type AgentIntelligence = {
  generatedAt: string;
  window: { from: string; to: string; agent: string | null; modality: ModalityFilter };
  views: {
    behavior: {
      tiles: [string, string, string][];
      nodes: GNode[];
      edges: GEdge[];
      systemRead: Chip[];
      sysreadSummary: string;
      plan: ActionPlanRow[];
      rejects: RejectRow[];
      fleet: {
        registered: number;
        idle: number;
        gap: number;
        runs: number;
        failed: number;
        cancelled: number;
      };
    };
  };
};

const priOf = (t: string): Pri =>
  t.startsWith("⚠") ? "high" : t.startsWith("◈") ? "medium" : "ok";
const summarize = (chips: Chip[]) =>
  `${chips.filter((c) => c.pri === "high").length} need action · ${chips.filter((c) => c.pri === "medium").length} to plan · ${chips.filter((c) => c.pri === "ok").length} healthy`;

export const agentIntelligence = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((input: unknown) => reportWindowSchema.parse(input ?? {}))
  .handler(async ({ context, data }): Promise<AgentIntelligence> => {
    const org = context.orgId;
    await assertRole(context.userId, org, [...GOVERNANCE_ROLES]);
    const win = resolveWindow(data);
    // every run-derived row is limited to runs started in the window (and to one agent when filtered)
    const inRun = and(
      eq(agentRuns.orgId, org),
      gte(agentRuns.createdAt, win.from),
      lte(agentRuns.createdAt, win.to),
      ...(win.agent ? [eq(agentRuns.agentType, win.agent as never)] : []),
      ...modalityWhere(agentRuns.agentType, win.modality),
    );

    const [
      runsByAgent,
      runsByStatus,
      tasksByAgentKind,
      rejectDetails,
      errorClusters,
      awaitingByAgent,
      definitions,
      defChurn,
      openByAgent,
      taskTotals,
      stageActorRows,
      orgCountRows,
      matchScoreRows,
    ] = await Promise.all([
      db
        .select({
          agentType: agentRuns.agentType,
          runs: agentRuns.id,
          steps: agentSteps.id,
        })
        .from(agentRuns)
        .leftJoin(agentSteps, eq(agentSteps.runId, agentRuns.id))
        .where(inRun),
      db.select({ status: agentRuns.status, n: agentRuns.id }).from(agentRuns).where(inRun),
      db
        .select({
          agentType: agentRuns.agentType,
          kind: agentTasks.kind,
          status: agentTasks.status,
          n: agentTasks.id,
        })
        .from(agentTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
        .where(and(eq(agentTasks.orgId, org), inRun)),
      db
        .select({
          agentType: agentRuns.agentType,
          kind: agentTasks.kind,
          title: agentTasks.title,
          tool: agentTasks.proposedAction,
        })
        .from(agentTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
        .where(and(eq(agentTasks.orgId, org), eq(agentTasks.status, "rejected"), inRun)),
      db
        .select({ agentType: agentRuns.agentType, tool: agentSteps.toolName, n: agentSteps.id })
        .from(agentSteps)
        .innerJoin(agentRuns, eq(agentRuns.id, agentSteps.runId))
        .where(and(eq(agentSteps.orgId, org), eq(agentSteps.status, "error"), inRun)),
      db
        .select({ agentType: agentRuns.agentType, n: agentRuns.id })
        .from(agentRuns)
        .where(and(inRun, eq(agentRuns.status, "awaiting_human"))),
      db
        .select({ agentType: agentDefinitions.agentType, version: agentDefinitions.version })
        .from(agentDefinitions)
        .orderBy(desc(agentDefinitions.createdAt)),
      db
        .select({ agentType: agentDefinitions.agentType, hash: agentDefinitions.hash })
        .from(agentDefinitions),
      db
        .select({ agentType: agentRuns.agentType, n: agentTasks.id })
        .from(agentTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
        .where(and(eq(agentTasks.orgId, org), eq(agentTasks.status, "open"), inRun)),
      db
        .select({ status: agentTasks.status, n: agentTasks.id })
        .from(agentTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentTasks.runId))
        .where(and(eq(agentTasks.orgId, org), inRun)),
      db
        .select({ actor: stageEvents.actor, n: stageEvents.id })
        .from(stageEvents)
        .where(
          and(
            eq(stageEvents.orgId, org),
            gte(stageEvents.createdAt, win.from),
            lte(stageEvents.createdAt, win.to),
          ),
        ),
      db.select({ n: agentRuns.id }).from(agentRuns).where(inRun),
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
    for (const [, m] of errByAgent)
      for (const [tool, n] of m) errByTool.set(tool, (errByTool.get(tool) ?? 0) + n);
    const awaitingMap = new Map<string, number>();
    for (const r of awaitingByAgent)
      awaitingMap.set(r.agentType, (awaitingMap.get(r.agentType) ?? 0) + 1);
    const openMap = new Map<string, number>();
    for (const r of openByAgent) openMap.set(r.agentType, (openMap.get(r.agentType) ?? 0) + 1);
    const churn = new Map<string, number>();
    for (const r of defChurn) churn.set(r.agentType, (churn.get(r.agentType) ?? 0) + 1);
    const defVersions = new Map<string, string>();
    // rows arrive newest-first; prefer the newest released version over eval/test manifests
    const isPrerelease = (v: string) => /-(eval|test)/.test(v);
    for (const r of definitions) {
      const cur = defVersions.get(r.agentType);
      if (cur === undefined || (isPrerelease(cur) && !isPrerelease(r.version)))
        defVersions.set(r.agentType, r.version);
    }
    const registered = [...new Set(definitions.map((d) => d.agentType))]
      .filter((a) => (!win.agent || a === win.agent) && matchesModality(a, win.modality))
      .sort();
    const taskStatus = { cancelled: 0, answered: 0, open: 0 };
    for (const r of taskTotals)
      if (r.status in taskStatus) taskStatus[r.status as keyof typeof taskStatus] += 1;
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
      [...runsAgg.entries()].map(([a, e]) => [
        a,
        {
          runs: e.runs.size,
          steps: e.steps,
          avg: Math.round((e.steps / Math.max(e.runs.size, 1)) * 10) / 10,
        },
      ]),
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
          id: `ag-${a}`,
          type: "agent",
          name: a,
          ver: defVersions.get(a),
          runs: 0,
          steps: 0,
          avg: 0,
          awaiting: 0,
          idle: true,
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
      const err = errByAgent.get(a)
        ? [...errByAgent.get(a)!.values()].reduce((x, y) => x + y, 0)
        : 0;
      const n: GNode = {
        id: `ag-${a}`,
        type: "agent",
        name: a,
        ver: defVersions.get(a),
        runs: st.runs,
        steps: st.steps,
        avg: st.avg,
        awaiting: awaitingMap.get(a) ?? 0,
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
        n.effect =
          err > 0
            ? `${err} tool errors — see the failure cluster.`
            : `Clean: no errors, no interventions.`;
        n.action = err > 5 ? `Investigate the failing tool before trusting the output.` : `None.`;
      } else {
        gapAgents.push(a);
        n.cause = `${st.runs} runs with no agent steps (voice/panel sessions — captured outside agent_steps).`;
        n.effect = `Behavior lives in call transcripts, not the step trace — these agents are invisible to every step-based governance rule.`;
        n.action = `Add session-shaped telemetry (turns, consent, tool calls) so voice/panel behavior joins the graph and its health rules.`;
        edges.push({ s: `ag-${a}`, t: "hub-gap", k: "gap", label: `×${st.runs} runs, 0 steps` });
      }
      if (err >= 5 && n.action && !n.action.includes("Top failure")) {
        const top = [...(errByAgent.get(a) ?? new Map<string, number>())].sort(
          (x, y) => y[1] - x[1],
        )[0];
        if (top)
          n.action = n.action.startsWith("None")
            ? `Investigate top failure ${top[0]} ×${top[1]}.`
            : `${n.action} Top failure: ${top[0]} ×${top[1]}.`;
      }
      nodes.push(n);
      if (appT > 0)
        edges.push({
          s: `ag-${a}`,
          t: "n-hitl",
          k: "gated",
          label: appR ? `×${appT}, ${appR} declined` : `×${appT}`,
        });
      if (gateT > 0)
        edges.push({
          s: `ag-${a}`,
          t: "n-gates",
          k: "gated",
          label: gateR ? `×${gateT}, ${gateR} declined` : `×${gateT}`,
        });
      if (cla > 0) edges.push({ s: `ag-${a}`, t: "n-clarify", k: "gated", label: `×${cla}` });
      for (const [tool, cnt] of errByAgent.get(a) ?? []) {
        if (cnt >= 3)
          edges.push({ s: `ag-${a}`, t: `fail-${tool}`, k: "errored", label: `×${cnt}` });
      }
    }

    if (idleAgents.length)
      nodes.push({
        id: "hub-idle",
        type: "hub",
        name: `${idleAgents.length} agents not used yet`,
        members: idleAgents,
        cause: `${idleAgents.length} of ${registered.length} registered agents ran zero times: ${idleAgents.join(", ")}.`,
        effect: `Copilot — the routing front door — is among them: requests reach specialists directly, so routing and its guardrails are untested.`,
        action: `Per agent: enable (tick, copilot route, feature flag) or park. An idle manifest should be a decision, not an accident.`,
      });
    if (gapAgents.length)
      nodes.push({
        id: "hub-gap",
        type: "hub",
        name: `${gapAgents.length} call agents (no step trace)`,
        members: gapAgents,
        cause: `${gapAgents.join(", ")} ran with zero rows in agent_steps — voice/panel sessions are captured out-of-band.`,
        effect: `These agents bypass every step-based rule: error clusters, run limits on tools, and this graph.`,
        action: `Emit session turns as steps (consent, tool calls, outcomes) — until then, treat their transcripts as unaudited.`,
      });

    const normSpecs = [
      {
        id: "n-hitl",
        name: "Approval cards",
        what: "proposed actions wait for a person (shortlist, feed listing…)",
        stops: norm.hitl.stops,
        rejected: norm.hitl.rejected,
      },
      {
        id: "n-gates",
        name: "Sign-off gates",
        what: "requisition/org-profile/jd approvals before any publish",
        stops: norm.gates.stops,
        rejected: norm.gates.rejected,
      },
      {
        id: "n-clarify",
        name: "Questions to a person",
        what: "agent asks, a person answers (ask_human)",
        stops: norm.clarify.stops,
        rejected: 0,
      },
    ];
    for (const s of normSpecs) {
      nodes.push({
        ...s,
        type: "norm",
        cause: `${s.what}. ${s.stops} stops folded from ${totalRuns} runs.`,
        effect:
          s.rejected > 0
            ? `${s.rejected} overturned by a person (${Math.round((s.rejected / Math.max(s.stops, 1)) * 100)}%) — the miscalibration signal.`
            : `Zero overturns — calibrated.`,
        action:
          s.rejected >= 3
            ? `This norm (or the proposals under it) needs review — see the rejected chains.`
            : `None.`,
      });
    }
    for (const [tool, count] of errByTool) {
      if (count < 3) continue;
      const parts = [...errByAgent.entries()]
        .filter(([, m]) => m.get(tool))
        .map(([a, m]) => `${a} ×${m.get(tool)}`)
        .join(" + ");
      nodes.push({
        id: `fail-${tool}`,
        type: "failure",
        name: tool,
        tool,
        cause: `${count} errors inside agent runs — ${parts}.`,
        effect:
          tool === "add_to_pipeline"
            ? `Duplicate-pipeline skips — the skip-already-in-pipeline fix should retire most of these; verify on the next run.`
            : tool === "read_org_website"
              ? `Failure rate this high on the tool the org profile is built from — network egress or parser sandbox, not the model.`
              : `Repeated tool failure — flaky dependency or bad input shape.`,
        action:
          tool === "add_to_pipeline"
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
        pri: "high",
        title: `⚠ org-site reads fail at scale (${webErr[1]} errors)`,
        short: `org-site reads failing ×${webErr[1]}`,
        cause: `${webErr[1]} of org_context's website reads errored — that is most of its read attempts, and it is the tool the org profile is built from.`,
        effect: `Org profiles may be silently thinner than they look; every downstream agent consumes them.`,
        action: `Check egress/parser-sandbox health first (infrastructure, not model). Then re-run an org_context stretch and compare profile depth.`,
      });
    const dupErr = [...errByTool.entries()].find(([t]) => t === "add_to_pipeline");
    if (dupErr && dupErr[1] >= 5)
      behaviorChips.push({
        pri: "high",
        title: `⚠ add_to_pipeline errors (${dupErr[1]} across agents)`,
        short: `pipeline dup errors ×${dupErr[1]}`,
        cause: `Duplicate-pipeline rejections across agents — retries waste run budget.`,
        effect: `After the skip-already-in-pipeline fix these should collapse.`,
        action: `Re-run an intake stretch and verify the count drops; if it doesn't, the fix regressed.`,
      });
    if (approvalsRejected >= 2) {
      const intakeR = taskStat("intake", "approval", "rejected");
      behaviorChips.push({
        pri: "high",
        title: `⚠ Persons are rejecting agent proposals (${approvalsRejected} overturns)`,
        short: `${approvalsRejected} of ${approvals} proposals declined (${Math.round((approvalsRejected / Math.max(approvals, 1)) * 100)}%)`,
        cause:
          intakeR >= 2
            ? `Intake's proposals were declined ${intakeR}× — mostly "${rejectRows.find((x) => x.agentType === "intake")?.title ?? "proposed action"}".`
            : `Rejections across ${new Set(rejectRows.map((r) => r.agentType)).size} agents.`,
        effect: `Overturn rate on HITL cards: ${Math.round((approvalsRejected / Math.max(approvals, 1)) * 100)}%. The agent's judgment and the reviewer's disagree.`,
        action: `Read the rejection reasons. If the wording is the problem, change the proposal copy; if the candidates are, change the scorer threshold. Don't touch the reviewer.`,
      });
    }
    if (idleAgents.includes("copilot"))
      behaviorChips.push({
        pri: "medium",
        title: `◈ The front door never opened — copilot has 0 runs`,
        short: `copilot never invoked — routing untested`,
        cause: `All ${totalRuns} runs started directly from a page; nobody has asked the Copilot to hand work to an agent yet.`,
        effect: `The Copilot's hand-off to agents is untried in your organisation.`,
        action: `Try one task through the Copilot so you know it works — or ignore this if your team prefers starting agents from each page.`,
      });
    if (gapAgents.length)
      behaviorChips.push({
        pri: "medium",
        title: `◈ ${gapAgents.join(", ")} run out-of-band — invisible to the step trace`,
        short: `${gapAgents.join(", ")}: runs with 0 steps`,
        cause: `Call and panel agents keep their work in call transcripts, not in step-by-step records.`,
        effect: `The automatic checks on this page cannot see inside those calls.`,
        action: `Review their call transcripts directly until step-level checks cover them.`,
      });
    const failRate = failed / Math.max(totalRuns, 1);
    behaviorChips.push({
      pri: failRate >= 0.1 ? "medium" : "ok",
      title:
        failRate >= 0.1
          ? `◈ ${failed} of ${totalRuns} runs failed (${Math.round(failRate * 100)}%) — ${awaiting} await a person`
          : `✓ The fleet is quiet — ${awaiting} runs await a person, ${failed} failed`,
      short:
        failRate >= 0.1
          ? `${failed}/${totalRuns} runs failed · ${awaiting} awaiting`
          : `fleet quiet — ${awaiting} awaiting, ${failed} failed`,
      cause: `${totalRuns} runs · ${totalSteps} steps · ${failed} failed · ${cancelledRuns} cancelled.`,
      effect: `Gate stops (${norm.hitl.stops + norm.gates.stops}) behaved as designed.`,
      action: `Open Agent activity, look at the failed runs and retry or report them. ${cancelledRuns} cancelled runs need no action.`,
    });
    behaviorChips.push({
      pri: "medium",
      title: `◈ Fleet coverage: ${registered.length - idleAgents.length}/${registered.length} agents active, ${idleAgents.length} idle`,
      short: `coverage ${registered.length - idleAgents.length}/${registered.length} active · ${idleAgents.length} idle`,
      cause: `${idleAgents.length} agents have manifests but no runs.`,
      effect: `Governance coverage is ${Math.round(((registered.length - idleAgents.length - gapAgents.length) / Math.max(registered.length, 1)) * 100)}% of the fleet.`,
      action: `See the action plan below: switch off agents you don't plan to use so the list reflects how you actually hire.`,
    });
    const behaviorSysread = behaviorChips.map((c) => ({ ...c, pri: priOf(c.title) }));
    behaviorChips.sort((a, b) => a.pri.localeCompare(b.pri));

    const plan: ActionPlanRow[] = [];
    for (const a of registered) {
      const st = statMap.get(a);
      const ver = defVersions.get(a) ?? "?";
      if (!st) {
        plan.push({
          name: a,
          ver,
          state: "idle",
          pri: "ok",
          runs: 0,
          stops: 0,
          overturned: 0,
          errors: 0,
          awaiting: 0,
          action: `Not used yet — turn it on in Agent settings if you expect it to work for you; otherwise no action.`,
        });
        continue;
      }
      const appT = taskTotal(a, "approval"),
        appR = taskStat(a, "approval", "rejected");
      const gateT = taskTotal(a, "gate"),
        gateR = taskStat(a, "gate", "rejected");
      const cla = taskTotal(a, "clarification");
      const errors = errByAgent.get(a)
        ? [...errByAgent.get(a)!.values()].reduce((x, y) => x + y, 0)
        : 0;
      const awaitingN = awaitingMap.get(a) ?? 0;
      const stops = appT + gateT + cla;
      const overturned = appR + gateR;
      let state: string, pri: Pri, action: string;
      if (st.steps === 0) {
        state = "no trace";
        pri = "medium";
        action = `Runs as a live call — review its call transcripts; step-level governance does not cover it yet.`;
      } else if (overturned >= 2 && stops > 0) {
        state = "out of sync";
        pri = "high";
        action = `Persons declined ${overturned} of ${stops} proposals — read the rejection reasons; fix proposal copy or scorer threshold, not the reviewer.`;
      } else if (errors >= 10) {
        const top = [...(errByAgent.get(a) ?? new Map<string, number>())].sort(
          (x, y) => y[1] - x[1],
        )[0];
        state = "failing";
        pri = "high";
        action = `${errors} failed tool calls${top ? ` — mostly ${top[0]} ×${top[1]}` : ""}. Ask your admin to check that step before relying on this agent's output.`;
      } else if (errors >= 3) {
        state = "flaky";
        pri = "medium";
        action = `${errors} failed tool calls — watch the next runs; escalate if the count keeps rising.`;
      } else if (awaitingN > 0) {
        state = "waiting";
        pri = "medium";
        action = `${awaitingN} run(s) parked awaiting a person — clear the decisions inbox.`;
      } else if (stops > 0) {
        state = "healthy";
        pri = "ok";
        action = `None — ${stops} touchpoints, overturn rate inside band.`;
      } else {
        state = "clean";
        pri = "ok";
        action =
          errors > 0
            ? `None — ${errors} isolated failed call(s), below the alert threshold.`
            : `None — autonomous, no errors, no interventions.`;
      }
      plan.push({
        name: a,
        ver,
        state,
        pri,
        runs: st.runs,
        stops,
        overturned,
        errors,
        awaiting: awaitingN,
        action,
      });
    }
    const priOrder = { high: 0, medium: 1, ok: 2 } as const;
    plan.sort(
      (x, y) =>
        priOrder[x.pri] - priOrder[y.pri] || y.errors - x.errors || x.name.localeCompare(y.name),
    );

    return {
      generatedAt: new Date().toISOString(),
      window: {
        from: win.from.toISOString(),
        to: win.to.toISOString(),
        agent: win.agent,
        modality: win.modality,
      },
      views: {
        behavior: {
          tiles: [
            ["Runs", String(totalRuns), `${failed} failed · ${cancelledRuns} cancelled`],
            [
              "Agent steps",
              String(totalSteps),
              `${registered.length - idleAgents.length}/${registered.length} registered agents active`,
            ],
            [
              "Person touchpoints",
              String(norm.hitl.stops + norm.gates.stops + norm.clarify.stops),
              `${approvalsRejected + gatesRejected} declined · ${taskStatus.open} still open`,
            ],
            ["Match scores", String(matchScoresCount), "candidates scored against requisitions"],
          ],
          nodes,
          edges,
          systemRead: behaviorSysread
            .map((c) => ({ ...c, pri: priOf(c.title) }))
            .sort((a, b) => priOrder[a.pri] - priOrder[b.pri]),
          sysreadSummary: summarize(behaviorSysread),
          plan,
          rejects: rejectRows,
          fleet: {
            registered: registered.length,
            idle: idleAgents.length,
            gap: gapAgents.length,
            runs: totalRuns,
            failed,
            cancelled: cancelledRuns,
          },
        },
      },
    };
  });
