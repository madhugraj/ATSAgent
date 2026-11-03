/**
 * Voice agents' observability (Agent observability → Voice agents): the live
 * phone calls — screening, scheduling and pay — over the last 14 days. Calls
 * are measured as calls (reached, completed, length, how they ended, how
 * smoothly the assistant's voice went out), never as AI request latency.
 * Organisation-scoped; no audio, words, numbers or vendor names.
 */
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { LIVE_VOICE_SQL_LIST } from "../server/ai-usage";
import { db } from "../server/db";
import { requireOrg } from "./auth.middleware";
import { CHOPPY_GAPS_PER_MINUTE } from "./voice-quality";

export type VoicePurpose = "screening" | "scheduling" | "negotiation";

export type VoiceAgentStats = {
  purpose: VoicePurpose;
  /** Calls placed (dialled at least once) in 14 days. */
  placed: number;
  /** The person answered. */
  reached: number;
  /** Ran to the end the agent meant (completed / booked / agreed). */
  completed: number;
  noAnswer: number;
  failed: number;
  medianMinutes: number | null;
  p95Minutes: number | null;
  /** How the calls that were answered ended, most common first. */
  endReasons: { reason: string; calls: number }[];
  /** Calls with audio measured, and gaps in the assistant's speech per minute. */
  audioCalls: number;
  gapsPerMinute: number | null;
  /** Calls where the assistant's speech broke up (more than 2 gaps a minute). */
  choppyCalls: number;
  tokens: number;
};

export type VoiceDay = {
  day: string;
  screening: number;
  scheduling: number;
  negotiation: number;
  /** Average gaps a minute across that day's measured calls. */
  gapsPerMinute: number | null;
};

const PURPOSES: VoicePurpose[] = ["screening", "scheduling", "negotiation"];
const FEATURE: Record<VoicePurpose, string> = {
  screening: "screening_call",
  scheduling: "scheduling_call",
  negotiation: "negotiation_call",
};

const q = async (s: ReturnType<typeof sql>) =>
  (await db.execute(s)) as unknown as Record<string, unknown>[];
const num = (v: unknown) => (v == null ? null : Number(v));

/** The voice agents' 14 days, for one organisation (shared by the page and tests). */
export const voiceStats = createServerOnlyFn(async function voiceStats(
  org: string,
): Promise<{ agents: VoiceAgentStats[]; daily: VoiceDay[] }> {
  {
    const gpm = sql`((c.audio_stats ->> 'gaps')::numeric / greatest(c.duration_s, 1) * 60)`;
    const stats = await q(sql`
      select c.purpose,
        count(*) filter (where c.attempt >= 1 or c.started_at is not null)::int placed,
        count(*) filter (where c.started_at is not null)::int reached,
        count(*) filter (where c.status = 'completed')::int completed,
        count(*) filter (where c.status = 'no_answer' or c.end_reason = 'no_answer')::int no_answer,
        count(*) filter (where c.status = 'failed')::int failed,
        percentile_cont(0.5) within group (order by c.duration_s) filter (where c.duration_s > 0) med_s,
        percentile_cont(0.95) within group (order by c.duration_s) filter (where c.duration_s > 0) p95_s,
        count(*) filter (where c.audio_stats is not null and c.duration_s > 0)::int audio_calls,
        avg(${gpm}) filter (where c.audio_stats is not null and c.duration_s > 0) gpm,
        count(*) filter (where c.audio_stats is not null and c.duration_s > 0
          and ${gpm} > ${CHOPPY_GAPS_PER_MINUTE})::int choppy
      from screening_calls c
      where c.org_id = ${org} and c.created_at >= now() - interval '14 days'
      group by c.purpose`);
    const reasons = await q(sql`
      select c.purpose, c.end_reason, count(*)::int n
      from screening_calls c
      where c.org_id = ${org} and c.created_at >= now() - interval '14 days'
        and c.started_at is not null and c.end_reason is not null
      group by 1, 2 order by n desc`);
    const tokens = await q(sql`
      select feature, coalesce(sum(total_tokens), 0)::bigint tokens
      from ai_usage_events
      where org_id = ${org} and created_at >= now() - interval '14 days'
        and feature in ${sql.raw(LIVE_VOICE_SQL_LIST)}
      group by feature`);
    const days = await q(sql`
      with d as (select (current_date - g)::date as day from generate_series(0, 13) g)
      select d.day::text as day,
        count(c.id) filter (where c.purpose = 'screening')::int screening,
        count(c.id) filter (where c.purpose = 'scheduling')::int scheduling,
        count(c.id) filter (where c.purpose = 'negotiation')::int negotiation,
        avg(${gpm}) filter (where c.audio_stats is not null and c.duration_s > 0) gpm
      from d left join screening_calls c on c.org_id = ${org}
        and (c.created_at at time zone 'utc')::date = d.day
      group by d.day order by d.day`);

    const agents = PURPOSES.map((purpose): VoiceAgentStats => {
      const r = stats.find((x) => x["purpose"] === purpose) ?? {};
      const minutes = (v: unknown) => (num(v) == null ? null : Math.round(Number(v) / 6) / 10);
      return {
        purpose,
        placed: Number(r["placed"] ?? 0),
        reached: Number(r["reached"] ?? 0),
        completed: Number(r["completed"] ?? 0),
        noAnswer: Number(r["no_answer"] ?? 0),
        failed: Number(r["failed"] ?? 0),
        medianMinutes: minutes(r["med_s"]),
        p95Minutes: minutes(r["p95_s"]),
        endReasons: reasons
          .filter((x) => x["purpose"] === purpose)
          .map((x) => ({ reason: String(x["end_reason"]), calls: Number(x["n"]) })),
        audioCalls: Number(r["audio_calls"] ?? 0),
        gapsPerMinute: num(r["gpm"]) == null ? null : Math.round(Number(r["gpm"]) * 10) / 10,
        choppyCalls: Number(r["choppy"] ?? 0),
        tokens: Number(tokens.find((t) => t["feature"] === FEATURE[purpose])?.["tokens"] ?? 0),
      };
    });
    const daily = days.map((x) => ({
      day: String(x["day"]),
      screening: Number(x["screening"]),
      scheduling: Number(x["scheduling"]),
      negotiation: Number(x["negotiation"]),
      gapsPerMinute: num(x["gpm"]) == null ? null : Math.round(Number(x["gpm"]) * 10) / 10,
    }));
    return { agents, daily };
  }
});

export const voiceObservability = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }) => voiceStats(context.orgId));
