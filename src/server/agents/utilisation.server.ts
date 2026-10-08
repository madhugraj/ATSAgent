/**
 * Agent utilisation & efficiency (Agent observability): what the agents used
 * day by day — tokens (and cost, at the organisation's own rate), agent
 * working time and time spent waiting for people — per-agent efficiency, and
 * concrete, evidence-backed recommendations to save cost and time.
 *
 * Costs exist only when the organisation has entered its token prices
 * (agent_cost_rates); the app never assumes a vendor price. Recommendations
 * are rules with explicit thresholds so every one is explainable.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { agentCostRates } from "@db/schema";

export const UTIL = {
  /** Share of an agent's tokens spent in failed / stopped runs that is worth fixing. */
  wasteShare: 0.1,
  /** Action approvals per run, and unchanged-approval rate, that suggest a higher autonomy level. */
  approvalsPerRun: 1.5,
  unchangedRate: 0.85,
  minDecisions: 8,
  /** Share of elapsed time spent waiting for people that is worth acting on. */
  waitShare: 0.7,
  /** Repeated identical read calls per run that suggest wasted turns. */
  repeatsPerRun: 1.5,
  /** Share of an agent's tokens used by one AI skill inside its tools. */
  skillShare: 0.4,
  /** Model-turn p95 (seconds) considered slow. */
  slowTurnSeconds: 20,
  /** Week-on-week growth in tokens per run worth a look. */
  growth: 0.3,
  /** Input share of tokens, and tokens per run, that point at long re-sent conversations. */
  inputShare: 0.85,
  heavyRunTokens: 50_000,
} as const;

export type CostRate = { currency: string; inputPerMillion: number; outputPerMillion: number };

export type UtilDay = {
  day: string;
  /** Tokens per agent type that day. */
  tokens: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
  /** Hours agents spent working (model turns and tools). */
  agentHours: number;
  /** Hours requests decided that day had waited for a person. */
  waitHours: number;
};

export type AgentEfficiency = {
  agentType: string;
  runs: number;
  done: number;
  failed: number;
  cancelled: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Tokens spent in runs that failed or were stopped. */
  wastedTokens: number;
  tokensPerDoneRun: number | null;
  /** Agent working minutes per finished run. */
  agentMinutesPerRun: number | null;
  /** Median hours a request waited for a person. */
  medianWaitHours: number | null;
  approvals: number;
  approvalsUnchanged: number;
  approvalsPerRun: number | null;
  repeatedReadsPerRun: number | null;
  topRepeatedTool: string | null;
  /** The AI skill (inside tools) with the largest token share, and that share. */
  topSkill: { feature: string; share: number } | null;
  p95TurnSeconds: number | null;
  tokensPerRunThisWeek: number | null;
  tokensPerRunLastWeek: number | null;
  monthTokens: number;
  monthlyBudget: number | null;
  autonomy: string | null;
};

export type Recommendation = {
  agentType: string;
  kind:
    | "waste"
    | "autonomy"
    | "waiting"
    | "repeats"
    | "skill"
    | "slow"
    | "growth"
    | "budget"
    | "context";
  severity: "save" | "watch";
  title: string;
  evidence: string;
  action: string;
  /** Estimated saving per week, when one can be estimated. */
  saving: { tokens?: number; hours?: number; approvals?: number } | null;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const fmt = (n: number) =>
  n >= 1_000_000
    ? `${r1(n / 1_000_000)}M`
    : n >= 1_000
      ? `${r1(n / 1_000)}K`
      : String(Math.round(n));

/** Cost of tokens at the organisation's rate; null when no rate is set. */
export function costOf(rate: CostRate | null, prompt: number, completion: number): number | null {
  if (!rate) return null;
  return (prompt / 1e6) * rate.inputPerMillion + (completion / 1e6) * rate.outputPerMillion;
}

/** Evidence-backed recommendations from the efficiency numbers. Pure — unit-tested. */
export function recommend(
  agents: AgentEfficiency[],
  opts: { days: number; today: Date },
): Recommendation[] {
  const out: Recommendation[] = [];
  const perWeek = (n: number) => (n * 7) / Math.max(1, opts.days);
  for (const a of agents) {
    const name = a.agentType;
    if (a.tokens > 0 && a.wastedTokens / a.tokens >= UTIL.wasteShare) {
      out.push({
        agentType: name,
        kind: "waste",
        severity: "save",
        title: `${pct(a.wastedTokens / a.tokens)} of tokens went to runs that failed or were stopped`,
        evidence: `${fmt(a.wastedTokens)} of ${fmt(a.tokens)} tokens; ${a.failed} failed and ${a.cancelled} stopped of ${a.runs} runs.`,
        action:
          "Open the failed runs (Agent activity → Steps) and the issues for this agent: fix the key, quota or tool error behind them, and switch the agent off for roles where it keeps failing.",
        saving: { tokens: Math.round(perWeek(a.wastedTokens)) },
      });
    }
    if (
      a.approvals >= UTIL.minDecisions &&
      (a.approvalsPerRun ?? 0) >= UTIL.approvalsPerRun &&
      a.approvalsUnchanged / a.approvals >= UTIL.unchangedRate &&
      a.autonomy === "suggest"
    ) {
      out.push({
        agentType: name,
        kind: "autonomy",
        severity: "save",
        title: "Most approvals are rubber stamps — raise autonomy to Act and notify",
        evidence: `${a.approvalsPerRun} approvals per run; ${pct(a.approvalsUnchanged / a.approvals)} of ${a.approvals} were approved unchanged; median wait ${a.medianWaitHours ?? "—"} h.`,
        action:
          "In Agent settings set this agent to Act and notify: internal changes run at once and you are told; decisions (approvals of requisitions, JDs, offers) still come to people.",
        saving: {
          approvals: Math.round(perWeek(a.approvalsUnchanged)),
          ...(a.medianWaitHours != null
            ? { hours: r1(perWeek(a.approvalsUnchanged) * a.medianWaitHours) }
            : {}),
        },
      });
    }
    if (
      a.medianWaitHours != null &&
      a.agentMinutesPerRun != null &&
      a.medianWaitHours * 60 > 0 &&
      (a.medianWaitHours * 60) / (a.medianWaitHours * 60 + a.agentMinutesPerRun) >=
        UTIL.waitShare &&
      a.approvals >= 3
    ) {
      out.push({
        agentType: name,
        kind: "waiting",
        severity: "watch",
        title: "Runs spend most of their time waiting for people",
        evidence: `About ${a.agentMinutesPerRun} min of agent work per run against a median ${a.medianWaitHours} h wait for each decision.`,
        action:
          "Decide from the bell or the hiring-desk thread as requests arrive, switch on the Follow-up agent to chase overdue approvers, and pre-approve message templates people always accept.",
        saving: null,
      });
    }
    if (
      a.tokens > 0 &&
      a.promptTokens / a.tokens >= UTIL.inputShare &&
      (a.tokensPerDoneRun ?? 0) >= UTIL.heavyRunTokens
    ) {
      out.push({
        agentType: name,
        kind: "context",
        severity: "save",
        title: "Long runs re-send their whole conversation on every step",
        evidence: `${pct(a.promptTokens / a.tokens)} of tokens are input; a finished run uses about ${fmt(a.tokensPerDoneRun ?? 0)} tokens over ~${a.approvalsPerRun ?? 0} approval round-trips.`,
        action:
          "Each pause for an approval adds model turns that re-read everything so far. Fewer round-trips cut this most: raise the agent to Act and notify for internal changes, and approve in the thread as soon as requests arrive so runs stay short.",
        saving: null,
      });
    }
    if ((a.repeatedReadsPerRun ?? 0) >= UTIL.repeatsPerRun && a.topRepeatedTool) {
      out.push({
        agentType: name,
        kind: "repeats",
        severity: "watch",
        title: `The agent repeats the same lookups (mostly ${a.topRepeatedTool})`,
        evidence: `${a.repeatedReadsPerRun} repeated identical reads per run — each one is an extra model turn.`,
        action:
          "Usually the agent re-checks a record after every approval. Review its instructions (Agent register) so it reads once and keeps the result; report it to the product team if it persists.",
        saving: null,
      });
    }
    if (a.topSkill && a.topSkill.share >= UTIL.skillShare) {
      out.push({
        agentType: name,
        kind: "skill",
        severity: "watch",
        title: `${pct(a.topSkill.share)} of this agent's tokens go to ${a.topSkill.feature.replace(/_/g, " ")}`,
        evidence: "This AI skill runs inside one of the agent's tools and dominates its spend.",
        action:
          "Check it is worth it per run — e.g. reuse market research for similar roles instead of re-running it, or limit how many items it processes per run.",
        saving: null,
      });
    }
    if ((a.p95TurnSeconds ?? 0) >= UTIL.slowTurnSeconds) {
      out.push({
        agentType: name,
        kind: "slow",
        severity: "watch",
        title: "AI responses are slow for this agent",
        evidence: `p95 model turn ${a.p95TurnSeconds} s.`,
        action:
          "Long transcripts slow every turn: keep runs short (one role per run) and check the AI model's latency in Integrations → AI model.",
        saving: null,
      });
    }
    if (
      a.tokensPerRunThisWeek != null &&
      a.tokensPerRunLastWeek != null &&
      a.tokensPerRunLastWeek > 0 &&
      a.tokensPerRunThisWeek / a.tokensPerRunLastWeek - 1 >= UTIL.growth
    ) {
      out.push({
        agentType: name,
        kind: "growth",
        severity: "watch",
        title: `Tokens per run grew ${pct(a.tokensPerRunThisWeek / a.tokensPerRunLastWeek - 1)} this week`,
        evidence: `${fmt(a.tokensPerRunThisWeek)} per run this week vs ${fmt(a.tokensPerRunLastWeek)} last week.`,
        action:
          "Check whether a definition change or larger inputs (longer CVs, more candidates per run) caused it; compare a run with a dry-run replay.",
        saving: null,
      });
    }
    if (a.monthlyBudget && a.monthTokens > 0) {
      const dayOfMonth = opts.today.getUTCDate();
      const daysInMonth = new Date(
        Date.UTC(opts.today.getUTCFullYear(), opts.today.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const projected = (a.monthTokens / dayOfMonth) * daysInMonth;
      if (projected > a.monthlyBudget) {
        const runOut = Math.min(
          daysInMonth,
          Math.max(dayOfMonth, Math.floor(a.monthlyBudget / (a.monthTokens / dayOfMonth))),
        );
        const date = new Date(
          Date.UTC(opts.today.getUTCFullYear(), opts.today.getUTCMonth(), runOut),
        );
        out.push({
          agentType: name,
          kind: "budget",
          severity: a.monthTokens >= a.monthlyBudget ? "save" : "watch",
          title:
            a.monthTokens >= a.monthlyBudget
              ? "Monthly token budget used up — the agent is paused"
              : `Monthly budget runs out around ${date.toISOString().slice(0, 10)}`,
          evidence: `${fmt(a.monthTokens)} of ${fmt(a.monthlyBudget)} used by day ${dayOfMonth}; on track for ${fmt(projected)} this month.`,
          action:
            "Raise the budget in Agent settings if the work is worth it, or reduce what the agent does (fewer sweeps, smaller batches).",
          saving: null,
        });
      }
    }
  }
  const rank = { save: 0, watch: 1 } as const;
  return out.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

type Row = Record<string, unknown>;
const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as Row[];
const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));

export type Utilisation = {
  days: number;
  rate: CostRate | null;
  series: UtilDay[];
  agents: (AgentEfficiency & { cost: number | null; costPerRun: number | null })[];
  totals: {
    tokens: number;
    cost: number | null;
    agentHours: number;
    waitHours: number;
    wastedTokens: number;
  };
  recommendations: Recommendation[];
};

export async function agentUtilisation(orgId: string, days: 14 | 30 = 30): Promise<Utilisation> {
  const since = sql`(current_date - ${days - 1}::int)`;
  const [rateRow] = await db
    .select()
    .from(agentCostRates)
    .where(eq(agentCostRates.orgId, orgId))
    .limit(1);
  const rate: CostRate | null = rateRow
    ? {
        currency: rateRow.currency,
        inputPerMillion: Number(rateRow.inputPerMillion),
        outputPerMillion: Number(rateRow.outputPerMillion),
      }
    : null;

  const tokenRows = await q(sql`
    select (u.created_at at time zone 'utc')::date::text as day, r.agent_type,
      coalesce(sum(u.total_tokens), 0)::bigint tokens,
      coalesce(sum(u.prompt_tokens), 0)::bigint prompt,
      coalesce(sum(u.completion_tokens), 0)::bigint completion
    from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
    where r.org_id = ${orgId} and r.mode = 'live' and u.created_at >= ${since}
    group by 1, 2`);
  const workRows = await q(sql`
    select (s.created_at at time zone 'utc')::date::text as day, coalesce(sum(s.duration_ms), 0)::bigint ms
    from agent_steps s join agent_runs r on r.id = s.run_id
    where s.org_id = ${orgId} and r.mode = 'live' and s.created_at >= ${since}
    group by 1`);
  const waitRows = await q(sql`
    select (decided_at at time zone 'utc')::date::text as day,
      coalesce(sum(extract(epoch from (decided_at - created_at))), 0) secs
    from agent_tasks where org_id = ${orgId} and decided_at >= ${since}
    group by 1`);
  const dayList = (
    await q(sql`
    select (current_date - g)::date::text as day from generate_series(0, ${days - 1}::int) g order by 1`)
  ).map((r) => String(r["day"]));
  const series: UtilDay[] = dayList.map((day) => {
    const t = tokenRows.filter((r) => r["day"] === day);
    return {
      day,
      tokens: Object.fromEntries(t.map((r) => [String(r["agent_type"]), n(r["tokens"])])),
      promptTokens: t.reduce((s, r) => s + n(r["prompt"]), 0),
      completionTokens: t.reduce((s, r) => s + n(r["completion"]), 0),
      agentHours: r1(n(workRows.find((r) => r["day"] === day)?.["ms"]) / 3_600_000),
      waitHours: r1(n(waitRows.find((r) => r["day"] === day)?.["secs"]) / 3600),
    };
  });

  const agentRows = await q(sql`
    with r as (
      select * from agent_runs where org_id = ${orgId} and mode = 'live' and created_at >= ${since}
    ),
    tok as (
      select r.agent_type, r.id run_id, r.status,
        coalesce(sum(u.total_tokens), 0) tokens, coalesce(sum(u.prompt_tokens), 0) prompt,
        coalesce(sum(u.completion_tokens), 0) completion
      from r left join ai_usage_events u on u.agent_run_id = r.id
      group by r.agent_type, r.id, r.status
    ),
    work as (
      select r.agent_type, r.id run_id, coalesce(sum(s.duration_ms), 0) ms
      from r left join agent_steps s on s.run_id = r.id group by r.agent_type, r.id
    ),
    reps as (
      select x.agent_type, x.run_id, x.tool_name, count(*) - 1 extra
      from (
        select r.agent_type, s.run_id, s.tool_name, s.input::text inp
        from agent_steps s join r on r.id = s.run_id
        where s.kind = 'tool' and s.status = 'ok' and s.tool_name like 'get\\_%'
      ) x group by x.agent_type, x.run_id, x.tool_name, x.inp having count(*) > 1
    ),
    tasks as (
      select r.agent_type, t.kind, t.status, t.response, t.created_at, t.decided_at
      from agent_tasks t join r on r.id = t.run_id
    ),
    turns as (
      select r.agent_type,
        percentile_cont(0.95) within group (order by s.duration_ms) p95
      from agent_steps s join r on r.id = s.run_id where s.kind = 'model' group by r.agent_type
    )
    select a.agent_type,
      count(*)::int runs,
      count(*) filter (where a.status = 'done')::int done,
      count(*) filter (where a.status = 'failed')::int failed,
      count(*) filter (where a.status = 'cancelled')::int cancelled,
      (select coalesce(sum(tokens), 0) from tok where tok.agent_type = a.agent_type)::bigint tokens,
      (select coalesce(sum(prompt), 0) from tok where tok.agent_type = a.agent_type)::bigint prompt,
      (select coalesce(sum(completion), 0) from tok where tok.agent_type = a.agent_type)::bigint completion,
      (select coalesce(sum(tokens), 0) from tok where tok.agent_type = a.agent_type
        and tok.status in ('failed','cancelled'))::bigint wasted,
      (select percentile_cont(0.5) within group (order by tokens) from tok
        where tok.agent_type = a.agent_type and tok.status = 'done') tokens_per_done,
      (select avg(ms) / 60000.0 from work w join r r2 on r2.id = w.run_id
        where w.agent_type = a.agent_type and r2.status in ('done','failed')) agent_min,
      (select percentile_cont(0.5) within group (order by extract(epoch from (decided_at - created_at)) / 3600)
        from tasks where tasks.agent_type = a.agent_type and decided_at is not null) wait_h,
      (select count(*) from tasks where tasks.agent_type = a.agent_type and kind = 'approval'
        and status in ('approved','rejected'))::int approvals,
      (select count(*) from tasks where tasks.agent_type = a.agent_type and kind = 'approval'
        and status = 'approved' and not (coalesce(response, '{}'::jsonb) ? 'args'))::int unchanged,
      (select coalesce(sum(extra), 0) from reps where reps.agent_type = a.agent_type)::int repeats,
      (select tool_name from reps where reps.agent_type = a.agent_type
        group by tool_name order by sum(extra) desc limit 1) top_repeat,
      (select p95 from turns where turns.agent_type = a.agent_type) p95_turn,
      (select percentile_cont(0.5) within group (order by tokens) from tok join r r3 on r3.id = tok.run_id
        where tok.agent_type = a.agent_type and r3.created_at >= now() - interval '7 days') tpr_week,
      (select percentile_cont(0.5) within group (order by tokens) from tok join r r4 on r4.id = tok.run_id
        where tok.agent_type = a.agent_type and r4.created_at >= now() - interval '14 days'
          and r4.created_at < now() - interval '7 days') tpr_last
    from r a group by a.agent_type`);

  const skillRows = await q(sql`
    select r.agent_type, u.feature, coalesce(sum(u.total_tokens), 0)::bigint tokens
    from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
    where r.org_id = ${orgId} and r.mode = 'live' and u.created_at >= ${since}
      and u.feature not like 'agent\\_%'
    group by 1, 2`);
  const monthRows = await q(sql`
    select r.agent_type, coalesce(sum(u.total_tokens), 0)::bigint tokens
    from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
    where r.org_id = ${orgId} and u.created_at >= date_trunc('month', now())
    group by 1`);
  const policyRows = await q(sql`
    select agent_type, autonomy, monthly_token_budget from agent_policies
    where org_id = ${orgId} and agent_type <> '*'`);

  const agents = agentRows.map((r) => {
    const type = String(r["agent_type"]);
    const tokens = n(r["tokens"]);
    const finished = n(r["done"]) + n(r["failed"]);
    const skills = skillRows.filter((s) => s["agent_type"] === type);
    const top = skills.sort((a, b) => n(b["tokens"]) - n(a["tokens"]))[0];
    const pol = policyRows.find((p) => p["agent_type"] === type);
    const eff: AgentEfficiency = {
      agentType: type,
      runs: n(r["runs"]),
      done: n(r["done"]),
      failed: n(r["failed"]),
      cancelled: n(r["cancelled"]),
      tokens,
      promptTokens: n(r["prompt"]),
      completionTokens: n(r["completion"]),
      wastedTokens: n(r["wasted"]),
      tokensPerDoneRun:
        nn(r["tokens_per_done"]) == null ? null : Math.round(n(r["tokens_per_done"])),
      agentMinutesPerRun: nn(r["agent_min"]) == null ? null : r1(n(r["agent_min"])),
      medianWaitHours: nn(r["wait_h"]) == null ? null : r1(n(r["wait_h"])),
      approvals: n(r["approvals"]),
      approvalsUnchanged: n(r["unchanged"]),
      approvalsPerRun: n(r["runs"]) ? r1(n(r["approvals"]) / n(r["runs"])) : null,
      repeatedReadsPerRun: n(r["runs"]) ? r1(n(r["repeats"]) / n(r["runs"])) : null,
      topRepeatedTool: r["top_repeat"] ? String(r["top_repeat"]) : null,
      topSkill:
        top && tokens
          ? { feature: String(top["feature"]), share: n(top["tokens"]) / tokens }
          : null,
      p95TurnSeconds: nn(r["p95_turn"]) == null ? null : r1(n(r["p95_turn"]) / 1000),
      tokensPerRunThisWeek: nn(r["tpr_week"]) == null ? null : Math.round(n(r["tpr_week"])),
      tokensPerRunLastWeek: nn(r["tpr_last"]) == null ? null : Math.round(n(r["tpr_last"])),
      monthTokens: n(monthRows.find((m) => m["agent_type"] === type)?.["tokens"]),
      monthlyBudget: pol?.["monthly_token_budget"] != null ? n(pol["monthly_token_budget"]) : null,
      autonomy: pol?.["autonomy"] ? String(pol["autonomy"]) : null,
    };
    const cost = costOf(rate, eff.promptTokens, eff.completionTokens);
    return {
      ...eff,
      cost,
      costPerRun: cost != null && finished ? cost / finished : null,
    };
  });
  agents.sort((a, b) => b.tokens - a.tokens);

  const tokensTotal = agents.reduce((s, a) => s + a.tokens, 0);
  return {
    days,
    rate,
    series,
    agents,
    totals: {
      tokens: tokensTotal,
      cost: costOf(
        rate,
        agents.reduce((s, a) => s + a.promptTokens, 0),
        agents.reduce((s, a) => s + a.completionTokens, 0),
      ),
      agentHours: r1(series.reduce((s, d) => s + d.agentHours, 0)),
      waitHours: r1(series.reduce((s, d) => s + d.waitHours, 0)),
      wastedTokens: agents.reduce((s, a) => s + a.wastedTokens, 0),
    },
    recommendations: recommend(agents, { days, today: new Date() }),
  };
}

/** Save (or clear) the organisation's token prices. */
export async function saveCostRate(
  orgId: string,
  userId: string,
  rate: CostRate | null,
): Promise<void> {
  if (!rate) {
    await db.delete(agentCostRates).where(eq(agentCostRates.orgId, orgId));
    return;
  }
  const values = {
    currency: rate.currency,
    inputPerMillion: String(rate.inputPerMillion),
    outputPerMillion: String(rate.outputPerMillion),
    updatedBy: userId,
    updatedAt: new Date(),
  };
  await db
    .insert(agentCostRates)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: agentCostRates.orgId, set: values });
}
