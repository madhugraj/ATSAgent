/**
 * What hiring costs in AI, per candidate and per role (docs/agentic-plan.md
 * §9.4). Read from the AI ledger: every request carries the role / candidate it
 * was made for (ai_usage_events.requisition_id / application_id / candidate_id,
 * set by the attribution scope in agents/context.ts) and the agent run it ran
 * in.
 *
 * - A candidate's direct cost: AI work done for them alone — reading their CV,
 *   matching, screening kit and assessment, interview scheduling, evaluation,
 *   offer and pre-onboarding — plus every request of an agent run that was
 *   about them (subject = their application).
 * - A role's shared cost: AI work for the role as a whole — the requisition,
 *   JD, publishing, sourcing and searches, the hiring-desk conversation, and
 *   agent turns spent across candidates.
 * - Cost per hire: everything the role cost (shared + all candidates) divided
 *   by hires. Money only at the organisation's own token prices
 *   (agent_cost_rates); tokens always.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { agentCostRates, applications, candidates, requisitions } from "@db/schema";
import { costOf, type CostRate } from "./utilisation.server";

/** Feature → the hiring stage it belongs to, in the order a hire goes through them. */
export const COST_STAGES: { stage: string; features: string[] }[] = [
  {
    stage: "Reading & checking the CV",
    features: ["resume_parse", "claim_verify", "linkedin_signal", "writing_signal"],
  },
  {
    stage: "Matching",
    features: ["candidate_score", "talent_search", "agent_intake", "agent_sourcing"],
  },
  {
    stage: "Screening",
    features: [
      "screening_kit",
      "screening_grade",
      "audio_transcribe",
      "assessment_generate",
      "assessment_score",
      "agent_screening",
    ],
  },
  { stage: "Interviews", features: ["agent_interview"] },
  { stage: "Evaluation", features: ["agent_evaluation"] },
  {
    stage: "Offer",
    features: ["agent_offer", "offer_letter", "salary_research", "market_benchmark"],
  },
  { stage: "Pre-onboarding", features: ["agent_onboarding", "doc_extract"] },
];
const stageOf = (feature: string) =>
  COST_STAGES.find((s) => s.features.includes(feature))?.stage ?? "Other";

type Totals = { tokens: number; promptTokens: number; completionTokens: number; requests: number };
export type CostLine = Totals & { cost: number | null };
export type CandidateCost = CostLine & {
  applicationId: string;
  candidate: string;
  stage: string;
  byStage: (CostLine & { stage: string })[];
};
export type RoleCost = {
  requisition: { id: string; code: string; title: string };
  currency: string | null;
  total: CostLine;
  shared: CostLine & { byFeature: (CostLine & { feature: string })[] };
  candidates: CandidateCost[];
  hires: number;
  /** Total ÷ hires; null until someone is hired. */
  costPerHire: CostLine | null;
};

async function rateOf(orgId: string): Promise<CostRate | null> {
  const [r] = await db
    .select()
    .from(agentCostRates)
    .where(eq(agentCostRates.orgId, orgId))
    .limit(1);
  return r
    ? {
        currency: r.currency,
        inputPerMillion: Number(r.inputPerMillion),
        outputPerMillion: Number(r.outputPerMillion),
      }
    : null;
}

const line = (t: Totals, rate: CostRate | null): CostLine => ({
  ...t,
  cost: costOf(rate, t.promptTokens, t.completionTokens),
});
const zero = (): Totals => ({ tokens: 0, promptTokens: 0, completionTokens: 0, requests: 0 });
const add = (a: Totals, b: Totals): Totals => ({
  tokens: a.tokens + b.tokens,
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  requests: a.requests + b.requests,
});

/**
 * Every ledger row for a role, each tagged with the application it belongs to
 * (null = shared by the role). One query; the rules are in the CASE.
 */
async function roleRows(orgId: string, requisitionId: string) {
  return (await db.execute(sql`
    with apps as (
      select id, candidate_id from applications
      where requisition_id = ${requisitionId} and org_id = ${orgId}
    ),
    runs as (
      select r.id, case when r.subject_type = 'application' then r.subject_id end as app_id
      from agent_runs r
      where r.org_id = ${orgId} and (
        (r.subject_type = 'requisition' and r.subject_id = ${requisitionId})
        or (r.subject_type = 'application' and r.subject_id in (select id from apps))
        or r.conversation_id in (
          select id from hiring_conversations where requisition_id = ${requisitionId} and org_id = ${orgId}
        )
      )
    )
    select
      coalesce(
        e.application_id,
        (select app_id from runs where runs.id = e.agent_run_id),
        (select a.id from apps a where a.candidate_id = e.candidate_id limit 1)
      ) as app_id,
      e.feature,
      count(*)::int as requests,
      coalesce(sum(e.total_tokens), 0)::bigint as tokens,
      coalesce(sum(e.prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(e.completion_tokens), 0)::bigint as completion_tokens
    from ai_usage_events e
    where e.org_id = ${orgId} and (
      e.requisition_id = ${requisitionId}
      or e.application_id in (select id from apps)
      or e.agent_run_id in (select id from runs)
      or (e.candidate_id in (select candidate_id from apps) and e.requisition_id is null)
    )
    group by 1, 2`)) as unknown as {
    app_id: string | null;
    feature: string;
    requests: number;
    tokens: string | number;
    prompt_tokens: string | number;
    completion_tokens: string | number;
  }[];
}

export async function roleCost(orgId: string, requisitionId: string): Promise<RoleCost> {
  const [req] = await db
    .select({ id: requisitions.id, code: requisitions.code, title: requisitions.title })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  const rate = await rateOf(orgId);
  const rows = await roleRows(orgId, requisitionId);
  const apps = await db
    .select({ id: applications.id, stage: applications.stage, name: candidates.fullName })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.requisitionId, requisitionId), eq(applications.orgId, orgId)));

  let total = zero();
  let shared = zero();
  const sharedByFeature = new Map<string, Totals>();
  const perApp = new Map<string, { all: Totals; byStage: Map<string, Totals> }>();
  for (const r of rows) {
    const t: Totals = {
      tokens: Number(r.tokens),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      requests: Number(r.requests),
    };
    total = add(total, t);
    if (!r.app_id || !apps.some((a) => a.id === r.app_id)) {
      shared = add(shared, t);
      sharedByFeature.set(r.feature, add(sharedByFeature.get(r.feature) ?? zero(), t));
      continue;
    }
    const e = perApp.get(r.app_id) ?? { all: zero(), byStage: new Map<string, Totals>() };
    e.all = add(e.all, t);
    const st = stageOf(r.feature);
    e.byStage.set(st, add(e.byStage.get(st) ?? zero(), t));
    perApp.set(r.app_id, e);
  }
  const order = [...COST_STAGES.map((s) => s.stage), "Other"];
  const cands: CandidateCost[] = apps
    .map((a) => {
      const e = perApp.get(a.id) ?? { all: zero(), byStage: new Map<string, Totals>() };
      return {
        applicationId: a.id,
        candidate: a.name,
        stage: a.stage,
        ...line(e.all, rate),
        byStage: order
          .filter((s) => e.byStage.has(s))
          .map((s) => ({ stage: s, ...line(e.byStage.get(s)!, rate) })),
      };
    })
    .sort((x, y) => y.tokens - x.tokens);
  const hires = apps.filter((a) => ["offer_accepted", "hired", "joined"].includes(a.stage)).length;
  return {
    requisition: req,
    currency: rate?.currency ?? null,
    total: line(total, rate),
    shared: {
      ...line(shared, rate),
      byFeature: [...sharedByFeature]
        .map(([feature, t]) => ({ feature, ...line(t, rate) }))
        .sort((x, y) => y.tokens - x.tokens),
    },
    candidates: cands,
    hires,
    costPerHire: hires
      ? line(
          {
            tokens: Math.round(total.tokens / hires),
            promptTokens: Math.round(total.promptTokens / hires),
            completionTokens: Math.round(total.completionTokens / hires),
            requests: Math.round(total.requests / hires),
          },
          rate,
        )
      : null,
  };
}

/** One candidate's direct cost for one role, with the role's figures for context. */
export async function candidateCost(
  orgId: string,
  applicationId: string,
): Promise<{
  candidate: CandidateCost;
  role: Omit<RoleCost, "candidates"> & { candidates: number };
}> {
  const [app] = await db
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found.");
  const role = await roleCost(orgId, app.requisitionId);
  const candidate = role.candidates.find((c) => c.applicationId === applicationId)!;
  return { candidate, role: { ...role, candidates: role.candidates.length } };
}
