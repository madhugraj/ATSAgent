/**
 * What hiring costs in AI, per candidate, per role and across the
 * organisation (docs/agentic-plan.md §9.4). Read from the AI ledger: every
 * request carries the role / candidate it was made for
 * (ai_usage_events.requisition_id / application_id / candidate_id, set by the
 * attribution scope in agents/context.ts) and the agent run it ran in.
 *
 * - A candidate's direct cost: AI work done for them alone — reading their CV,
 *   matching, screening and assessment, interview scheduling, evaluation, offer
 *   and pre-onboarding — plus every request of an agent run about them.
 * - A role's shared cost: AI work for the role as a whole — requisition, JD,
 *   publishing, sourcing and searches, the hiring-desk conversation, agent
 *   turns spent across candidates.
 * - Cost per hire: what the role cost (shared + all candidates) ÷ hires.
 *
 * Money: the organisation's own rate (agent_cost_rates) when set, else the
 * model's published list price on the day of each request (ai-pricing.ts).
 * Requests on a model with no price on file are counted as unpriced tokens —
 * never guessed. No vendor or model name leaves this module.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { agentCostRates, applications, candidates, requisitions } from "@db/schema";
import { PRICE_LIST, priceBucket, priceEntry, type OrgRate } from "../ai-pricing";

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
const STAGE_ORDER = [...COST_STAGES.map((s) => s.stage), "Other"];
const HIRED = ["offer_accepted", "hired", "joined"];
const NOT_HIRED = ["rejected", "withdrawn", "offer_declined"];

export type CostLine = {
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  /** Money for the priced part; null when nothing could be priced. */
  cost: number | null;
  /** Tokens on a model with no price on file (left out of `cost`). */
  unpricedTokens: number;
};
export type CandidateCost = CostLine & {
  applicationId: string;
  candidate: string;
  stage: string;
  byStage: (CostLine & { stage: string })[];
};
export type Pricing = {
  currency: string | null;
  /** Where the money comes from. */
  basis: "org_rate" | "list_price" | null;
  /** Day the list prices were read from the providers' pages. */
  checkedOn: string | null;
};
export type RoleCost = Pricing & {
  requisition: { id: string; code: string; title: string };
  total: CostLine;
  shared: CostLine & { byFeature: (CostLine & { feature: string })[] };
  candidates: CandidateCost[];
  hires: number;
  /** Total ÷ hires; null until someone is hired. */
  costPerHire: CostLine | null;
};

/* ------------------------------------------------------------ accumulation */

class Acc {
  tokens = 0;
  promptTokens = 0;
  completionTokens = 0;
  requests = 0;
  cost = 0;
  priced = false;
  unpricedTokens = 0;
  add(b: Bucket, rate: OrgRate | null, pricing: Pricing) {
    this.tokens += b.tokens;
    this.promptTokens += b.promptTokens;
    this.completionTokens += b.completionTokens;
    this.requests += b.requests;
    const p = priceBucket(b, rate);
    if (p) {
      this.cost += p.cost;
      this.priced = true;
      pricing.currency ??= p.currency;
      pricing.basis ??= p.basis;
    } else this.unpricedTokens += b.tokens;
  }
  merge(o: Acc) {
    this.tokens += o.tokens;
    this.promptTokens += o.promptTokens;
    this.completionTokens += o.completionTokens;
    this.requests += o.requests;
    this.cost += o.cost;
    this.priced ||= o.priced;
    this.unpricedTokens += o.unpricedTokens;
  }
  line(): CostLine {
    return {
      tokens: this.tokens,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      requests: this.requests,
      cost: this.priced ? this.cost : null,
      unpricedTokens: this.unpricedTokens,
    };
  }
  per(n: number): CostLine | null {
    if (!n) return null;
    const l = this.line();
    return {
      tokens: Math.round(l.tokens / n),
      promptTokens: Math.round(l.promptTokens / n),
      completionTokens: Math.round(l.completionTokens / n),
      requests: Math.round(l.requests / n),
      cost: l.cost == null ? null : l.cost / n,
      unpricedTokens: Math.round(l.unpricedTokens / n),
    };
  }
}
const acc = () => new Acc();
function bump<K>(m: Map<K, Acc>, k: K): Acc {
  let a = m.get(k);
  if (!a) m.set(k, (a = acc()));
  return a;
}

async function rateOf(orgId: string): Promise<OrgRate | null> {
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

/* ------------------------------------------------------------ the ledger */

type Bucket = {
  reqId: string | null;
  appId: string | null;
  feature: string;
  provider: string;
  model: string;
  day: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  grounded: number;
};

/**
 * Ledger rows grouped by role, candidate application, feature, model and day.
 * A row's application: its own tag, else its agent run's subject, else (CV
 * reads) the candidate's application for that role. Its role: its own tag,
 * else the application's role, else its run's role or desk thread.
 */
async function ledger(
  orgId: string,
  opts: { requisitionId?: string; from?: Date; to?: Date },
): Promise<Bucket[]> {
  const rows = (await db.execute(sql`
    with ev as (
      select e.*,
        coalesce(
          e.application_id,
          case when r.subject_type = 'application' then r.subject_id end,
          case when e.candidate_id is not null then (
            select a.id from applications a
            where a.org_id = ${orgId} and a.candidate_id = e.candidate_id
              and (e.requisition_id is null or a.requisition_id = e.requisition_id)
            order by a.applied_at desc limit 1) end
        ) as app_x,
        case when r.subject_type = 'requisition' then r.subject_id end as run_req,
        hc.requisition_id as conv_req
      from ai_usage_events e
      left join agent_runs r on r.id = e.agent_run_id
      left join hiring_conversations hc on hc.id = r.conversation_id
      where e.org_id = ${orgId}
        ${opts.from ? sql`and e.created_at >= ${opts.from.toISOString()}::timestamptz` : sql``}
        ${opts.to ? sql`and e.created_at < ${opts.to.toISOString()}::timestamptz` : sql``}
    ),
    tagged as (
      select ev.*, coalesce(ev.requisition_id, a.requisition_id, ev.run_req, ev.conv_req) as req_x
      from ev left join applications a on a.id = ev.app_x
    )
    select req_x as req_id, app_x as app_id, feature, provider, model,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as requests,
      coalesce(sum(total_tokens), 0)::bigint as tokens,
      coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(completion_tokens), 0)::bigint as completion_tokens,
      count(*) filter (where grounded)::int as grounded
    from tagged
    ${opts.requisitionId ? sql`where req_x = ${opts.requisitionId}` : sql``}
    group by 1, 2, 3, 4, 5, 6`)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    reqId: (r["req_id"] as string | null) ?? null,
    appId: (r["app_id"] as string | null) ?? null,
    feature: String(r["feature"]),
    provider: String(r["provider"] ?? ""),
    model: String(r["model"] ?? ""),
    day: String(r["day"]),
    requests: Number(r["requests"]),
    tokens: Number(r["tokens"]),
    promptTokens: Number(r["prompt_tokens"]),
    completionTokens: Number(r["completion_tokens"]),
    grounded: Number(r["grounded"]),
  }));
}

const checkedOn = () =>
  PRICE_LIST.map((p) => p.checkedOn)
    .sort()
    .at(-1) ?? null;

/* ------------------------------------------------------------ one role */

export async function roleCost(orgId: string, requisitionId: string): Promise<RoleCost> {
  const [req] = await db
    .select({ id: requisitions.id, code: requisitions.code, title: requisitions.title })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  const rate = await rateOf(orgId);
  const pricing: Pricing = { currency: null, basis: null, checkedOn: null };
  const rows = await ledger(orgId, { requisitionId });
  const apps = await db
    .select({ id: applications.id, stage: applications.stage, name: candidates.fullName })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(applications.requisitionId, requisitionId), eq(applications.orgId, orgId)));
  const appIds = new Set(apps.map((a) => a.id));

  const total = acc();
  const shared = acc();
  const sharedByFeature = new Map<string, Acc>();
  const perApp = new Map<string, { all: Acc; byStage: Map<string, Acc> }>();
  for (const b of rows) {
    total.add(b, rate, pricing);
    if (!b.appId || !appIds.has(b.appId)) {
      shared.add(b, rate, pricing);
      bump(sharedByFeature, b.feature).add(b, rate, pricing);
      continue;
    }
    let e = perApp.get(b.appId);
    if (!e) perApp.set(b.appId, (e = { all: acc(), byStage: new Map() }));
    e.all.add(b, rate, pricing);
    bump(e.byStage, stageOf(b.feature)).add(b, rate, pricing);
  }
  const cands: CandidateCost[] = apps
    .map((a) => {
      const e = perApp.get(a.id) ?? { all: acc(), byStage: new Map<string, Acc>() };
      return {
        applicationId: a.id,
        candidate: a.name,
        stage: a.stage,
        ...e.all.line(),
        byStage: STAGE_ORDER.filter((s) => e.byStage.has(s)).map((s) => ({
          stage: s,
          ...e.byStage.get(s)!.line(),
        })),
      };
    })
    .sort((x, y) => y.tokens - x.tokens);
  const hires = apps.filter((a) => HIRED.includes(a.stage)).length;
  if (pricing.basis === "list_price") pricing.checkedOn = checkedOn();
  return {
    ...pricing,
    requisition: req,
    total: total.line(),
    shared: {
      ...shared.line(),
      byFeature: [...sharedByFeature]
        .map(([feature, a]) => ({ feature, ...a.line() }))
        .sort((x, y) => y.tokens - x.tokens),
    },
    candidates: cands,
    hires,
    costPerHire: total.per(hires),
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

/* ------------------------------------------------------------ the organisation */

export type OrgHiringCost = Pricing & {
  window: { from: string; to: string; months: number };
  total: CostLine;
  /** AI work not tied to any role (talent pool, copilot, organisation set-up). */
  notTiedToRole: CostLine;
  hires: number;
  costPerHire: CostLine | null;
  months: (CostLine & { month: string; hires: number; costPerHire: CostLine | null })[];
  roles: {
    id: string;
    code: string;
    title: string;
    status: string;
    candidates: number;
    hires: number;
    total: CostLine;
    shared: CostLine;
    /** Average direct cost of a candidate on this role. */
    perCandidate: CostLine | null;
    costPerHire: CostLine | null;
  }[];
  stages: (CostLine & { stage: string })[];
  /** Direct candidate cost by where the candidate ended up. */
  outcomes: { hired: CostLine; notHired: CostLine; inProgress: CostLine };
  /** Web-search grounding requests (billed per 1,000 beyond a monthly allowance). */
  grounding: { requests: number; billable: number; cost: number | null };
};

const monthOf = (day: string) => day.slice(0, 7);

/**
 * Hiring cost across every role over the last `months` calendar months
 * (this month included): totals, month by month (spend ÷ offers accepted that
 * month), each role, each hiring stage, and where candidate spend ended up.
 */
export async function orgHiringCost(
  orgId: string,
  opts: { months?: number } = {},
): Promise<OrgHiringCost> {
  const months = Math.min(Math.max(opts.months ?? 6, 1), 24);
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rate = await rateOf(orgId);
  const pricing: Pricing = { currency: null, basis: null, checkedOn: null };
  const rows = await ledger(orgId, { from, to });

  const reqIds = [...new Set(rows.map((r) => r.reqId).filter((x): x is string => !!x))];
  const reqs = reqIds.length
    ? ((await db.execute(sql`
        select r.id, r.code, r.title, r.status::text as status,
          (select count(*) from applications a where a.requisition_id = r.id)::int as candidates,
          (select count(*) from applications a where a.requisition_id = r.id
             and a.stage::text in ('offer_accepted','hired','joined'))::int as hires
        from requisitions r
        where r.org_id = ${orgId} and r.id in (${sql.join(
          reqIds.map((id) => sql`${id}`),
          sql`, `,
        )})`)) as unknown as {
        id: string;
        code: string;
        title: string;
        status: string;
        candidates: number;
        hires: number;
      }[])
    : [];
  const appIds = [...new Set(rows.map((r) => r.appId).filter((x): x is string => !!x))];
  const appStage = new Map<string, string>(
    appIds.length
      ? (
          (await db.execute(sql`
            select id, stage::text as stage from applications
            where org_id = ${orgId} and id in (${sql.join(
              appIds.map((id) => sql`${id}`),
              sql`, `,
            )})`)) as unknown as { id: string; stage: string }[]
        ).map((a) => [a.id, a.stage])
      : [],
  );
  // Offers accepted per month (a hire is dated by its acceptance).
  const hiresByMonth = new Map<string, number>(
    (
      (await db.execute(sql`
        select to_char(min(created_at) at time zone 'UTC', 'YYYY-MM') as month, application_id
        from stage_events
        where org_id = ${orgId} and to_stage::text = 'offer_accepted'
        group by application_id
        having min(created_at) >= ${from.toISOString()}::timestamptz
          and min(created_at) < ${to.toISOString()}::timestamptz`)) as unknown as {
        month: string;
      }[]
    ).reduce((m, r) => m.set(r.month, (m.get(r.month) ?? 0) + 1), new Map<string, number>()),
  );

  const total = acc();
  const loose = acc();
  const byMonth = new Map<string, Acc>();
  const byReq = new Map<string, { all: Acc; shared: Acc; direct: Acc; apps: Set<string> }>();
  const byStage = new Map<string, Acc>();
  const outcomes = { hired: acc(), notHired: acc(), inProgress: acc() };
  const groundingByMonth = new Map<string, number>();
  let groundingModel: { provider: string; model: string } | null = null;
  for (const b of rows) {
    total.add(b, rate, pricing);
    bump(byMonth, monthOf(b.day)).add(b, rate, pricing);
    if (b.grounded) {
      groundingByMonth.set(
        monthOf(b.day),
        (groundingByMonth.get(monthOf(b.day)) ?? 0) + b.grounded,
      );
      groundingModel ??= { provider: b.provider, model: b.model };
    }
    if (!b.reqId) {
      loose.add(b, rate, pricing);
      continue;
    }
    let r = byReq.get(b.reqId);
    if (!r) byReq.set(b.reqId, (r = { all: acc(), shared: acc(), direct: acc(), apps: new Set() }));
    r.all.add(b, rate, pricing);
    if (!b.appId) {
      r.shared.add(b, rate, pricing);
      continue;
    }
    r.direct.add(b, rate, pricing);
    r.apps.add(b.appId);
    bump(byStage, stageOf(b.feature)).add(b, rate, pricing);
    const st = appStage.get(b.appId) ?? "";
    (HIRED.includes(st)
      ? outcomes.hired
      : NOT_HIRED.includes(st)
        ? outcomes.notHired
        : outcomes.inProgress
    ).add(b, rate, pricing);
  }

  // Grounding: billed per 1,000 requests beyond the monthly allowance (list price only).
  const g = groundingModel
    ? priceEntry(groundingModel.provider, groundingModel.model)?.grounding
    : null;
  let groundingRequests = 0;
  let billable = 0;
  for (const n of groundingByMonth.values()) {
    groundingRequests += n;
    billable += Math.max(0, n - (g?.freePerMonth ?? 0));
  }
  const groundingCost = g && !rate ? (billable / 1000) * g.perThousand : null;

  const hires = [...hiresByMonth.values()].reduce((a, b) => a + b, 0);
  const monthKeys: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    monthKeys.push(d.toISOString().slice(0, 7));
  }
  if (pricing.basis === "list_price") pricing.checkedOn = checkedOn();
  return {
    ...pricing,
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), months },
    total: total.line(),
    notTiedToRole: loose.line(),
    hires,
    costPerHire: total.per(hires),
    months: monthKeys.map((m) => {
      const a = byMonth.get(m) ?? acc();
      const h = hiresByMonth.get(m) ?? 0;
      return { month: m, ...a.line(), hires: h, costPerHire: a.per(h) };
    }),
    roles: reqs
      .map((r) => {
        const x = byReq.get(r.id) ?? { all: acc(), shared: acc(), direct: acc(), apps: new Set() };
        return {
          id: r.id,
          code: r.code,
          title: r.title,
          status: r.status,
          candidates: r.candidates,
          hires: r.hires,
          total: x.all.line(),
          shared: x.shared.line(),
          perCandidate: x.direct.per(x.apps.size),
          costPerHire: x.all.per(r.hires),
        };
      })
      .sort((a, b) => b.total.tokens - a.total.tokens),
    stages: STAGE_ORDER.filter((s) => byStage.has(s)).map((s) => ({
      stage: s,
      ...byStage.get(s)!.line(),
    })),
    outcomes: {
      hired: outcomes.hired.line(),
      notHired: outcomes.notHired.line(),
      inProgress: outcomes.inProgress.line(),
    },
    grounding: { requests: groundingRequests, billable, cost: groundingCost },
  };
}
