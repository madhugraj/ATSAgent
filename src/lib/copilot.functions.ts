import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import {
  applications,
  candidates,
  copilotMessages,
  departments,
  interviews,
  offers,
  requisitions,
} from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { MANUAL_TEXT } from "@/lib/user-manual";

export type CopilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

/** The single ongoing copilot conversation for the signed-in user. */
export const copilotHistory = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<CopilotMessage[]> => {
    const rows = await db
      .select({
        id: copilotMessages.id,
        role: copilotMessages.role,
        content: copilotMessages.content,
        createdAt: copilotMessages.createdAt,
      })
      .from(copilotMessages)
      .where(
        and(eq(copilotMessages.userId, context.userId), eq(copilotMessages.orgId, context.orgId)),
      )
      .orderBy(asc(copilotMessages.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }));
  });

export const clearCopilot = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }) => {
    await db
      .delete(copilotMessages)
      .where(
        and(eq(copilotMessages.userId, context.userId), eq(copilotMessages.orgId, context.orgId)),
      );
    return { ok: true };
  });

/** Live, org-scoped facts handed to the model so answers are grounded in real data. */
const snapshot = createServerOnlyFn(async function snapshot(orgId: string) {
  // Column aliases keep the snake_case snapshot payload the prompt has always used.
  const [reqs, cands, apps, ivs, offerRows, depts] = await Promise.all([
    db
      .select({
        code: requisitions.code,
        title: requisitions.title,
        status: requisitions.status,
        openings: requisitions.openings,
        location: requisitions.location,
        budget_ctc: requisitions.budgetCtc,
        experience_min: requisitions.experienceMin,
        experience_max: requisitions.experienceMax,
        must_have_skills: requisitions.mustHaveSkills,
      })
      .from(requisitions)
      .where(eq(requisitions.orgId, orgId))
      .orderBy(desc(requisitions.createdAt))
      .limit(60),
    db
      .select({
        id: candidates.id,
        skills: candidates.skills,
        experience_years: candidates.experienceYears,
        created_at: candidates.createdAt,
        last_synced_at: candidates.lastSyncedAt,
      })
      .from(candidates)
      .where(eq(candidates.orgId, orgId)),
    db
      .select({
        stage: applications.stage,
        requisition_id: applications.requisitionId,
        last_activity_at: applications.lastActivityAt,
      })
      .from(applications)
      .where(eq(applications.orgId, orgId)),
    db
      .select({
        level: interviews.level,
        status: interviews.status,
        scheduled_at: interviews.scheduledAt,
        interviewer: interviews.interviewer,
      })
      .from(interviews)
      .where(eq(interviews.orgId, orgId))
      .orderBy(asc(interviews.scheduledAt))
      .limit(60),
    db
      .select({
        status: offers.status,
        offered_ctc: offers.offeredCtc,
        joining_date: offers.joiningDate,
      })
      .from(offers)
      .where(eq(offers.orgId, orgId)),
    db
      .select({
        name: departments.name,
        budgeted_headcount: departments.budgetedHeadcount,
        budgeted_cost: departments.budgetedCost,
      })
      .from(departments)
      .where(eq(departments.orgId, orgId)),
  ]);

  const stageCounts: Record<string, number> = {};
  for (const a of apps) stageCounts[a.stage] = (stageCounts[a.stage] ?? 0) + 1;

  const skillCounts: Record<string, number> = {};
  for (const c of cands) for (const s of c.skills ?? []) skillCounts[s] = (skillCounts[s] ?? 0) + 1;
  const topSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  return {
    requisitions: reqs,
    departments: depts,
    candidateCount: cands.length,
    stageCounts,
    topSkills,
    interviews: ivs,
    offers: offerRows,
  };
});

/**
 * How the organisation's agents are doing (Agent observability), so "why is X slow /
 * failing" is answered from the same numbers the page shows: AI latency by feature
 * (live phone calls left out — a call is not a request), live calls by voice agent,
 * and open health issues. No vendor or model names.
 */
const agentHealth = createServerOnlyFn(async function agentHealth(orgId: string) {
  const { LIVE_VOICE_SQL_LIST } = await import("../server/ai-usage");
  const q = async (s: ReturnType<typeof sql>) =>
    (await db.execute(s)) as unknown as Record<string, unknown>[];
  const [latency, calls, issues] = await Promise.all([
    q(sql`
      select u.feature, (u.created_at at time zone 'utc')::date::text as day, count(*)::int requests,
        round((percentile_cont(0.95) within group (order by u.duration_ms) / 1000)::numeric) p95_s
      from ai_usage_events u join agent_runs r on r.id = u.agent_run_id
      where r.org_id = ${orgId} and u.created_at >= now() - interval '7 days'
        and u.duration_ms is not null and u.feature not in ${sql.raw(LIVE_VOICE_SQL_LIST)}
      group by 1, 2 order by p95_s desc limit 20`),
    q(sql`
      select purpose, (created_at at time zone 'utc')::date::text as day, count(*)::int calls,
        count(*) filter (where started_at is not null)::int answered,
        round(avg(duration_s) filter (where duration_s > 0) / 60.0, 1) avg_minutes,
        round(avg((audio_stats ->> 'gaps')::numeric / greatest(duration_s, 1) * 60)
          filter (where audio_stats is not null and duration_s > 0), 1) gaps_per_minute
      from screening_calls
      where org_id = ${orgId} and created_at >= now() - interval '14 days'
      group by 1, 2 order by 2 desc limit 30`),
    q(sql`
      select agent_type, rule, severity, title
      from agent_issues where org_id = ${orgId} and status = 'open'
      order by case severity when 'critical' then 0 when 'serious' then 1 else 2 end
      limit 12`),
  ]);
  return {
    note: "AI latency on Agent observability is the 95th percentile of AI requests inside agent runs, live phone calls excluded (a call session lasts minutes and is not a slow request). Health threshold: 60 s. Live calls are shown under Voice agents.",
    aiLatencyByFeatureAndDay7d: latency,
    liveCallsByDay14d: calls,
    openHealthIssues: issues,
  };
});

const SYSTEM = `You are the HR copilot inside a talent-acquisition system (ATS).
You help recruiters, HR heads and the CHRO understand their own live hiring data and
advise on process: requisition approvals, JD quality, JD↔CV matching weights,
interview scheduling, offers and pipeline risk.

Rules:
- Answer ONLY from the DATA SNAPSHOT provided plus general HR expertise. Never invent
  candidate names, numbers or requisitions that are not in the snapshot.
- If the snapshot has no data for the question, say so plainly and suggest the page to use.
- Be concise: short paragraphs or tight bullet lists. Numbers over adjectives.
- Never invent navigation. These are the ONLY pages that exist, use their exact names:
  Dashboard (/), Requisitions (/requisitions), Talent pool (/candidates),
  Matching engine (/matching), Interviews (/interviews), My interviews (/interviews/mine),
  Offers (/offers), IJP (/ijp), Reports (/reports), Users & roles (/team),
  Integrations (/integrations), Master data (/masters), Organisation (/organisation),
  Organisation profile (/org-profile), Hiring desk (/desk), Agent decisions (/agents),
  Agent observability (/agents/observability), Agent settings (/agents/settings),
  Agent register (/agents/register), Hiring cost (/hiring-cost),
  Platform console (/platform, product-owner super users only).
- Questions about agents — speed, AI latency, failures, phone calls, health warnings —
  answer from AGENT HEALTH in the snapshot: name the feature or voice agent and the day
  behind a change, and quote the numbers. Live phone calls never count as AI latency.
  If AGENT HEALTH has nothing on it, say so and point to Agent observability.
- User administration lives on Users & roles (/team): the organisation owner can invite
  people, grant or revoke roles, pause (disable) access, and permanently delete a member
  from the row action menu. Deleting removes their membership and roles; pausing keeps
  history intact. Owners cannot be deleted until ownership is transferred; a platform super
  user can delete any user, including an owner, from Platform console > Users.
- Organisation (/organisation): the owner edits the organisation profile and can archive the
  organisation. Archiving locks everyone out but deletes nothing; only a platform super user
  can restore it, and they also see every registered organisation's statistics.
- For "how do I ..." questions, answer strictly from the USER MANUAL below, quoting the
  real page names and the actual order of steps. Never invent a setting that is not in it.
- Return JSON: { "answer": "markdown-free plain text answer" }.

USER MANUAL (authoritative product documentation):
${MANUAL_TEXT}`;

export const askCopilot = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => z.object({ message: z.string().min(1).max(2000) }).parse(data))
  .handler(async ({ data, context }): Promise<{ answer: string }> => {
    const { aiJson } = await import("@/lib/ai-gateway.server");

    await db.insert(copilotMessages).values({
      userId: context.userId,
      orgId: context.orgId,
      role: "user",
      content: data.message,
    });

    const prior = await db
      .select({ role: copilotMessages.role, content: copilotMessages.content })
      .from(copilotMessages)
      .where(
        and(eq(copilotMessages.userId, context.userId), eq(copilotMessages.orgId, context.orgId)),
      )
      .orderBy(desc(copilotMessages.createdAt))
      .limit(12);

    const transcript = prior
      .reverse()
      .map((m) => `${m.role === "user" ? "HR" : "Copilot"}: ${m.content}`)
      .join("\n");

    const [facts, health] = await Promise.all([
      snapshot(context.orgId),
      agentHealth(context.orgId).catch(() => null),
    ]);

    const result = await aiJson<{ answer?: string }>({
      orgId: context.orgId,
      feature: "copilot",
      system: SYSTEM,
      prompt: `DATA SNAPSHOT (live, this organisation only):\n${JSON.stringify(facts).slice(0, 20000)}\n\nAGENT HEALTH (live, this organisation only):\n${JSON.stringify(health).slice(0, 6000)}\n\nCONVERSATION SO FAR:\n${transcript}\n\nAnswer the latest HR message.`,
    });

    const answer = result.ok
      ? (result.data.answer ?? "").trim() || "I could not produce an answer for that."
      : `I could not reach the AI model: ${result.message}`;

    await db.insert(copilotMessages).values({
      userId: context.userId,
      orgId: context.orgId,
      role: "assistant",
      content: answer,
    });

    return { answer };
  });
