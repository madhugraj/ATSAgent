/**
 * Agent governance read model (Agent intelligence → Governance): is the harness
 * holding, and are agent-to-agent hand-offs healthy? Five questions, all
 * computed from this organisation's runs, steps, events and policies against
 * the registered manifests. Deterministic — no model calls; no vendor or model
 * names in the payload.
 *
 * Hand-off channels:
 *   event      — a lifecycle event (agent_events) the orchestrator routes to an
 *                agent; the run keeps trigger_event_id.
 *   delegation — an agent calling start_agent (today: the copilot); the step's
 *                output carries the child runId.
 */
import { and, eq, inArray, or } from "drizzle-orm";

import { db } from "../db";
import { agentEvents, agentPolicies, agentRuns, agentSteps, agentTasks } from "@db/schema";
import { ensureAgentsRegistered } from "./index";
import { SUBMISSION_TOOLS, getTool, isGateToolName, listAgents } from "./registry";
import { CEILING_MESSAGE, LEG_LIMIT_MESSAGE, OLD_LIMIT_MESSAGE } from "./run-messages";

export type Tone = "good" | "warn" | "bad";
export type HarnessQuestion = {
  key: string;
  question: string;
  tone: Tone;
  title: string;
  detail: string;
};
export type HarnessLimitRow = {
  agent: string;
  refused: number;
  refusedTools: string[];
  injection: number;
};
export type HarnessAutonomyRow = {
  agent: string;
  enabled: boolean;
  autonomy: string;
  risk: "low" | "medium" | "high";
  writesRun: number;
  askedFirst: number;
  withoutApproval: number;
  flag: string | null;
};
export type HarnessDefinitionRow = {
  agent: string;
  current: string;
  owner: string;
  evals: number;
  runs: number;
  offVersion: { version: string; runs: number }[];
  flag: string | null;
};
export type HarnessHandoffNode = {
  id: string;
  type: "event" | "delegator" | "agent";
  name: string;
  count: number;
  failed: number;
};
export type HarnessHandoffEdge = { s: string; t: string; runs: number; failed: number };
export type HarnessDelegation = {
  from: string;
  to: string;
  goal: string;
  status: string;
  afterInjectionFlag: boolean;
  at: string;
};
export type HarnessBudgetRow = {
  agent: string;
  tokensMonth: number;
  budget: number | null;
  limitStops: number;
};
export type Harness = {
  questions: HarnessQuestion[];
  limits: HarnessLimitRow[];
  autonomy: HarnessAutonomyRow[];
  definitions: HarnessDefinitionRow[];
  handoffs: {
    nodes: HarnessHandoffNode[];
    edges: HarnessHandoffEdge[];
    events: {
      total: number;
      done: number;
      pending: number;
      failed: number;
      dead: number;
      oldestPendingMins: number | null;
    };
    unrouted: { type: string; n: number }[];
    principalShifts: number;
    overlaps: { agent: string; subject: string; runs: number }[];
    delegations: HarnessDelegation[];
    lineageGap: boolean;
  };
  budget: HarnessBudgetRow[];
};

const MAX_EVENT_ATTEMPTS = 3;
const isPrerelease = (v: string) => /-(eval|test)/.test(v);
const ACTIVE = new Set(["queued", "running", "awaiting_human"]);

export async function computeHarness(orgId: string): Promise<Harness> {
  ensureAgentsRegistered();
  const defs = listAgents();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [runs, events, policies, toolSteps, delegSteps, approvals] = await Promise.all([
    db
      .select({
        id: agentRuns.id,
        agentType: agentRuns.agentType,
        status: agentRuns.status,
        principalUserId: agentRuns.principalUserId,
        subjectId: agentRuns.subjectId,
        triggerEventId: agentRuns.triggerEventId,
        definitionVersion: agentRuns.definitionVersion,
        tokensUsed: agentRuns.tokensUsed,
        lastError: agentRuns.lastError,
        createdAt: agentRuns.createdAt,
        finishedAt: agentRuns.finishedAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, orgId)),
    db
      .select({
        id: agentEvents.id,
        type: agentEvents.type,
        actorUserId: agentEvents.actorUserId,
        status: agentEvents.status,
        attempts: agentEvents.attempts,
        createdAt: agentEvents.createdAt,
      })
      .from(agentEvents)
      .where(eq(agentEvents.orgId, orgId)),
    db
      .select({
        agentType: agentPolicies.agentType,
        enabled: agentPolicies.enabled,
        autonomy: agentPolicies.autonomy,
        monthlyTokenBudget: agentPolicies.monthlyTokenBudget,
      })
      .from(agentPolicies)
      .where(eq(agentPolicies.orgId, orgId)),
    db
      .select({
        runId: agentSteps.runId,
        toolName: agentSteps.toolName,
        status: agentSteps.status,
        injectionSuspected: agentSteps.injectionSuspected,
        seq: agentSteps.seq,
        toolCallId: agentSteps.toolCallId,
      })
      .from(agentSteps)
      .where(
        and(
          eq(agentSteps.orgId, orgId),
          or(eq(agentSteps.kind, "tool"), eq(agentSteps.injectionSuspected, true)),
        ),
      ),
    db
      .select({
        runId: agentSteps.runId,
        status: agentSteps.status,
        input: agentSteps.input,
        output: agentSteps.output,
        seq: agentSteps.seq,
        createdAt: agentSteps.createdAt,
      })
      .from(agentSteps)
      .where(and(eq(agentSteps.orgId, orgId), eq(agentSteps.toolName, "start_agent"))),
    db
      .select({
        runId: agentTasks.runId,
        status: agentTasks.status,
        proposedAction: agentTasks.proposedAction,
      })
      .from(agentTasks)
      .where(and(eq(agentTasks.orgId, orgId), inArray(agentTasks.kind, ["approval", "gate"]))),
  ]);

  const runById = new Map(runs.map((r) => [r.id, r]));
  const agentOfRun = (id: string) => runById.get(id)?.agentType ?? "?";

  // ---- 1. limits: refused tool calls and suspected injected instructions
  const limitMap = new Map<string, HarnessLimitRow>();
  const limitRow = (a: string) => {
    const r = limitMap.get(a) ?? { agent: a, refused: 0, refusedTools: [], injection: 0 };
    limitMap.set(a, r);
    return r;
  };
  const injectedRuns = new Map<string, number>(); // runId → first flagged seq
  for (const s of toolSteps) {
    const a = agentOfRun(s.runId);
    if (s.status === "blocked") {
      const r = limitRow(a);
      r.refused += 1;
      if (s.toolName && !r.refusedTools.includes(s.toolName)) r.refusedTools.push(s.toolName);
    }
    if (s.injectionSuspected) {
      limitRow(a).injection += 1;
      const prev = injectedRuns.get(s.runId);
      if (prev === undefined || s.seq < prev) injectedRuns.set(s.runId, s.seq);
    }
  }
  const limits = [...limitMap.values()].sort(
    (x, y) => y.injection - x.injection || y.refused - x.refused,
  );

  // ---- 2. autonomy: the dial vs the agent's risk tier, and what actually ran
  const policyOf = new Map(policies.map((p) => [p.agentType, p]));
  const orgSwitch = policyOf.get("*");
  const writesRun = new Map<string, number>();
  // a change that ran with no approved card for its tool call, by agent
  const approvedCalls = new Set<string>();
  for (const t of approvals) {
    const id = (t.proposedAction as { toolCallId?: unknown } | null)?.toolCallId;
    if (t.status === "approved" && typeof id === "string") approvedCalls.add(id);
  }
  const unapproved = new Map<string, number>();
  const taintedUnapproved = new Map<string, number>();
  for (const s of toolSteps) {
    if (s.status !== "ok" || !s.toolName) continue;
    if (getTool(s.toolName)?.risk === "read") continue;
    const a = agentOfRun(s.runId);
    writesRun.set(a, (writesRun.get(a) ?? 0) + 1);
    // hand-to-a-person tools never decide anything themselves
    if (SUBMISSION_TOOLS.has(s.toolName) || isGateToolName(s.toolName)) continue;
    if (s.toolCallId && approvedCalls.has(s.toolCallId)) continue;
    unapproved.set(a, (unapproved.get(a) ?? 0) + 1);
    const flagSeq = injectedRuns.get(s.runId);
    if (flagSeq !== undefined && flagSeq < s.seq)
      taintedUnapproved.set(a, (taintedUnapproved.get(a) ?? 0) + 1);
  }
  const askedFirst = new Map<string, number>();
  for (const t of approvals) {
    const a = agentOfRun(t.runId);
    askedFirst.set(a, (askedFirst.get(a) ?? 0) + 1);
  }
  const autonomy: HarnessAutonomyRow[] = defs
    .map((d) => {
      const p = policyOf.get(d.type);
      const enabled = Boolean(p?.enabled) && orgSwitch?.enabled !== false;
      const level = p?.autonomy ?? "suggest";
      let flag: string | null = null;
      const noCard = unapproved.get(d.type) ?? 0;
      const tainted = taintedUnapproved.get(d.type) ?? 0;
      if (tainted > 0)
        flag = `${tainted} change${tainted === 1 ? "" : "s"} after an injection flag with no approval`;
      else if (level === "suggest" && noCard > 0)
        flag = `${noCard} change${noCard === 1 ? "" : "s"} with no approval card, though set to ask first`;
      else if (enabled && d.riskTier === "high" && level !== "suggest")
        flag = "High-risk agent allowed to act without asking first";
      else if (enabled && d.riskTier === "medium" && level === "autonomous")
        flag = "Medium-risk agent set to fully autonomous";
      return {
        agent: d.type,
        enabled,
        autonomy: level,
        risk: d.riskTier,
        writesRun: writesRun.get(d.type) ?? 0,
        askedFirst: askedFirst.get(d.type) ?? 0,
        withoutApproval: unapproved.get(d.type) ?? 0,
        flag,
      };
    })
    .sort(
      (x, y) =>
        Number(Boolean(y.flag)) - Number(Boolean(x.flag)) ||
        Number(y.enabled) - Number(x.enabled) ||
        x.agent.localeCompare(y.agent),
    );

  // ---- 3. definitions: did runs execute the approved, tested manifest?
  const definitions: HarnessDefinitionRow[] = defs
    .map((d) => {
      const mine = runs.filter((r) => r.agentType === d.type);
      const off = new Map<string, number>();
      for (const r of mine) {
        const v = r.definitionVersion ?? "unrecorded";
        if (v !== d.version) off.set(v, (off.get(v) ?? 0) + 1);
      }
      const offVersion = [...off.entries()]
        .map(([version, n]) => ({ version, runs: n }))
        .sort((a, b) => b.runs - a.runs);
      const testRuns = offVersion
        .filter((o) => isPrerelease(o.version) || o.version === "unrecorded")
        .reduce((s, o) => s + o.runs, 0);
      let flag: string | null = null;
      if (testRuns > 0)
        flag = `${testRuns} run${testRuns === 1 ? "" : "s"} on a test or unrecorded definition`;
      else if (d.evals.length === 0) flag = "No eval covers this agent";
      else if (offVersion.length) flag = "Ran on an older definition";
      return {
        agent: d.type,
        current: d.version,
        owner: d.owner,
        evals: d.evals.length,
        runs: mine.length,
        offVersion,
        flag,
      };
    })
    .sort(
      (x, y) =>
        Number(Boolean(y.flag)) - Number(Boolean(x.flag)) ||
        y.runs - x.runs ||
        x.agent.localeCompare(y.agent),
    );

  // ---- 4. hand-offs between agents
  const eventById = new Map(events.map((e) => [e.id, e]));
  const nodes = new Map<string, HarnessHandoffNode>();
  const edges = new Map<string, HarnessHandoffEdge>();
  const bump = (id: string, type: HarnessHandoffNode["type"], name: string, failed: boolean) => {
    const n = nodes.get(id) ?? { id, type, name, count: 0, failed: 0 };
    n.count += 1;
    if (failed) n.failed += 1;
    nodes.set(id, n);
  };
  const link = (s: string, t: string, failed: boolean) => {
    const k = `${s}>${t}`;
    const e = edges.get(k) ?? { s, t, runs: 0, failed: 0 };
    e.runs += 1;
    if (failed) e.failed += 1;
    edges.set(k, e);
  };
  let principalShifts = 0;
  const routedTypes = new Set<string>();
  for (const r of runs) {
    if (!r.triggerEventId) continue;
    const ev = eventById.get(r.triggerEventId);
    if (!ev) continue;
    routedTypes.add(ev.type);
    const failed = r.status === "failed";
    bump(`ev-${ev.type}`, "event", ev.type, failed);
    bump(`ag-${r.agentType}`, "agent", r.agentType, failed);
    link(`ev-${ev.type}`, `ag-${r.agentType}`, failed);
    if (ev.actorUserId && r.principalUserId && ev.actorUserId !== r.principalUserId)
      principalShifts += 1;
  }
  const delegations: HarnessDelegation[] = [];
  for (const s of delegSteps) {
    const parent = runById.get(s.runId);
    if (!parent) continue;
    const input = (s.input ?? {}) as { agent?: unknown; goal?: unknown };
    const childId = (s.output as { runId?: unknown } | null)?.runId;
    const child = typeof childId === "string" ? runById.get(childId) : undefined;
    const to = child?.agentType ?? (typeof input.agent === "string" ? input.agent : "?");
    const failed = s.status !== "ok" || child?.status === "failed";
    const flagSeq = injectedRuns.get(parent.id);
    bump(`dl-${parent.agentType}`, "delegator", parent.agentType, failed);
    bump(`ag-${to}`, "agent", to, failed);
    link(`dl-${parent.agentType}`, `ag-${to}`, failed);
    if (child && parent.principalUserId !== child.principalUserId) principalShifts += 1;
    delegations.push({
      from: parent.agentType,
      to,
      goal: typeof input.goal === "string" ? input.goal.slice(0, 160) : "",
      status: s.status === "ok" ? (child?.status ?? "started") : s.status,
      afterInjectionFlag: flagSeq !== undefined && flagSeq < s.seq,
      at: s.createdAt.toISOString(),
    });
  }
  delegations.sort((a, b) => b.at.localeCompare(a.at));

  const now = Date.now();
  const pendingEvents = events.filter((e) => e.status === "pending" || e.status === "processing");
  const oldestPending = pendingEvents.reduce<number | null>((m, e) => {
    const age = Math.round((now - e.createdAt.getTime()) / 60000);
    return m === null || age > m ? age : m;
  }, null);
  const failedEvents = events.filter((e) => e.status === "failed");
  const unroutedMap = new Map<string, number>();
  for (const e of events)
    if (e.status === "done" && !routedTypes.has(e.type))
      unroutedMap.set(e.type, (unroutedMap.get(e.type) ?? 0) + 1);
  const unrouted = [...unroutedMap.entries()]
    .map(([type, n]) => ({ type, n }))
    .sort((a, b) => b.n - a.n);

  // two runs of the same agent on the same subject whose lifetimes overlap
  const overlapMap = new Map<string, { agent: string; subject: string; runs: number }>();
  const bySubject = new Map<string, typeof runs>();
  for (const r of runs) {
    if (!r.subjectId) continue;
    const k = `${r.agentType}|${r.subjectId}`;
    bySubject.set(k, [...(bySubject.get(k) ?? []), r]);
  }
  for (const [k, list] of bySubject) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let clash = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const prevEnd =
        prev.finishedAt?.getTime() ??
        (ACTIVE.has(prev.status) ? Infinity : prev.createdAt.getTime());
      if (sorted[i]!.createdAt.getTime() < prevEnd) clash += 1;
    }
    if (clash) {
      const [agent, subject] = k.split("|") as [string, string];
      overlapMap.set(k, { agent, subject: subject.slice(0, 8), runs: clash + 1 });
    }
  }
  const overlaps = [...overlapMap.values()].sort((a, b) => b.runs - a.runs);

  // ---- 5. budget and run limits
  const limitText = [LEG_LIMIT_MESSAGE, CEILING_MESSAGE, OLD_LIMIT_MESSAGE];
  const budget: HarnessBudgetRow[] = defs
    .map((d) => {
      const mine = runs.filter((r) => r.agentType === d.type);
      return {
        agent: d.type,
        tokensMonth: mine
          .filter((r) => r.createdAt >= monthStart)
          .reduce((s, r) => s + r.tokensUsed, 0),
        budget: policyOf.get(d.type)?.monthlyTokenBudget ?? null,
        limitStops: mine.filter((r) => r.lastError && limitText.includes(r.lastError)).length,
      };
    })
    .filter((b) => b.tokensMonth > 0 || b.limitStops > 0 || b.budget !== null)
    .sort((a, b) => b.limitStops - a.limitStops || b.tokensMonth - a.tokensMonth);

  // ---- the five answers
  const refusedTotal = limits.reduce((s, l) => s + l.refused, 0);
  const injectionTotal = limits.reduce((s, l) => s + l.injection, 0);
  const autonomyFlags = autonomy.filter((a) => a.flag);
  const defFlags = definitions.filter((d) => d.flag && d.runs > 0);
  const unrecordedTotal = definitions.reduce(
    (s, d) =>
      s + d.offVersion.filter((o) => o.version === "unrecorded").reduce((x, o) => x + o.runs, 0),
    0,
  );
  const testRunTotal = definitions.reduce(
    (s, d) =>
      s +
      d.offVersion
        .filter((o) => isPrerelease(o.version) || o.version === "unrecorded")
        .reduce((x, o) => x + o.runs, 0),
    0,
  );
  const dead = failedEvents.filter((e) => e.attempts >= MAX_EVENT_ATTEMPTS).length;
  const riskyDelegations = delegations.filter((d) => d.afterInjectionFlag).length;
  const overBudget = budget.filter((b) => b.budget !== null && b.tokensMonth > b.budget);
  const limitStops = budget.reduce((s, b) => s + b.limitStops, 0);

  const questions: HarnessQuestion[] = [
    {
      key: "limits",
      question: "Are agents staying inside their limits?",
      ...(injectionTotal > 0
        ? {
            tone: "bad" as const,
            title: `${injectionTotal} suspected injected instruction${injectionTotal === 1 ? "" : "s"}`,
            detail: `Untrusted text (CV, mail, web page) looked like it was giving the agent orders. ${refusedTotal} tool call${refusedTotal === 1 ? "" : "s"} refused by the harness.`,
          }
        : refusedTotal > 0
          ? {
              tone: "warn" as const,
              title: `${refusedTotal} tool call${refusedTotal === 1 ? "" : "s"} refused`,
              detail:
                "The harness blocked calls outside an agent's permissions — it held, but the agent tried.",
            }
          : {
              tone: "good" as const,
              title: "No refusals, no injection flags",
              detail: "Every tool call stayed inside the agent's permission scope.",
            }),
    },
    {
      key: "autonomy",
      question: "Does autonomy match risk?",
      ...(autonomyFlags.length
        ? {
            tone: "bad" as const,
            title: autonomyFlags.some((a) => a.withoutApproval > 0 && a.flag?.includes("approval"))
              ? `${autonomyFlags.length} agent${autonomyFlags.length === 1 ? "" : "s"} made changes nobody approved`
              : `${autonomyFlags.length} agent${autonomyFlags.length === 1 ? "" : "s"} trusted beyond their risk tier`,
            detail: autonomyFlags.map((a) => a.agent).join(", ") + " — tighten in Agent settings.",
          }
        : {
            tone: "good" as const,
            title: "Autonomy within risk tier",
            detail: `${autonomy.filter((a) => a.enabled).length} agents switched on; none allowed to act beyond its risk tier.`,
          }),
    },
    {
      key: "definitions",
      question: "Did agents run the approved definition?",
      ...(testRunTotal > 0
        ? {
            tone: "bad" as const,
            title: `${testRunTotal} run${testRunTotal === 1 ? "" : "s"} on test or unrecorded definitions`,
            detail:
              [
                unrecordedTotal
                  ? `${unrecordedTotal} run${unrecordedTotal === 1 ? "" : "s"} recorded no definition version, so nobody can prove which rulebook they followed`
                  : "",
                testRunTotal - unrecordedTotal
                  ? `${testRunTotal - unrecordedTotal} ran a test manifest (-eval / -test) against this organisation's data`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") + ".",
          }
        : defFlags.length
          ? {
              tone: "warn" as const,
              title: `${defFlags.length} agent${defFlags.length === 1 ? "" : "s"} need attention`,
              detail: defFlags.map((d) => `${d.agent}: ${d.flag}`).join(" · "),
            }
          : {
              tone: "good" as const,
              title: "All runs on current, tested definitions",
              detail: "Every run executed the locked manifest version with eval coverage.",
            }),
    },
    {
      key: "handoffs",
      question: "Are hand-offs between agents healthy?",
      ...(dead > 0 || riskyDelegations > 0 || overlaps.length > 0
        ? {
            tone: "bad" as const,
            title: "Hand-offs need attention",
            detail:
              [
                dead
                  ? `${dead} event${dead === 1 ? "" : "s"} gave up after ${MAX_EVENT_ATTEMPTS} attempts`
                  : "",
                riskyDelegations
                  ? `${riskyDelegations} delegation${riskyDelegations === 1 ? "" : "s"} after an injection flag`
                  : "",
                overlaps.length
                  ? `${overlaps.length} case${overlaps.length === 1 ? "" : "s"} of two runs on the same work`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") + ".",
          }
        : pendingEvents.length > 0 && (oldestPending ?? 0) > 60
          ? {
              tone: "warn" as const,
              title: `${pendingEvents.length} event${pendingEvents.length === 1 ? "" : "s"} waiting to be routed`,
              detail: `Oldest has waited ${Math.round((oldestPending ?? 0) / 60)}h — check the orchestrator is ticking.`,
            }
          : {
              tone: "good" as const,
              title: "Hand-offs flowing",
              detail: `${events.length} events, ${delegations.length} direct delegation${delegations.length === 1 ? "" : "s"}; none stuck or duplicated.`,
            }),
    },
    {
      key: "budget",
      question: "Are agents within budget and run limits?",
      ...(overBudget.length
        ? {
            tone: "bad" as const,
            title: `${overBudget.length} agent${overBudget.length === 1 ? "" : "s"} over monthly budget`,
            detail: overBudget.map((b) => b.agent).join(", "),
          }
        : limitStops > 0
          ? {
              tone: "warn" as const,
              title: `${limitStops} run${limitStops === 1 ? "" : "s"} stopped at a step or token limit`,
              detail:
                "Either the limit is too tight or the agent went round in circles — check the run before raising it.",
            }
          : {
              tone: "good" as const,
              title: "Within budget",
              detail: "No run hit its step or token ceiling this period.",
            }),
    },
  ];

  return {
    questions,
    limits,
    autonomy,
    definitions,
    handoffs: {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      events: {
        total: events.length,
        done: events.filter((e) => e.status === "done").length,
        pending: pendingEvents.length,
        failed: failedEvents.length,
        dead,
        oldestPendingMins: oldestPending,
      },
      unrouted,
      principalShifts,
      overlaps,
      delegations: delegations.slice(0, 20),
      lineageGap: true,
    },
    budget,
  };
}
