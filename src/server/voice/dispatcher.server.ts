/**
 * Which phone screening calls to place now (docs/voice-screening-agent.md):
 * approved calls, retries and callbacks that are due, for organisations whose
 * phone screening is ready, inside each organisation's own calling window and
 * time zone. Each call is claimed atomically (status → "dialling", attempt
 * counted) so two workers never dial the same call; calls a stopped worker
 * left behind are recovered.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { screeningCalls } from "@db/schema";
import { db } from "../db";
import { log } from "../log";
import { inWindow } from "./schedule";
import { phoneScreeningPolicyOf, phoneScreeningReadiness } from "./settings.server";

/** Statuses waiting for the worker (with a due time). */
export const WAITING = ["approved", "callback", "no_answer", "failed"] as const;

/** Due calls, oldest first, that have attempts left (a requested callback always does). */
export async function dueCalls(now: Date, limit = 50) {
  return db.execute<{ id: string; org_id: string }>(sql`
    select c.id, c.org_id
    from screening_calls c
    left join phone_screening_settings s on s.org_id = c.org_id
    join candidates cand on cand.id = c.candidate_id
    where c.status in ('approved', 'callback', 'no_answer', 'failed')
      -- Scheduling calls only while the organisation keeps them switched on.
      and (c.purpose <> 'scheduling' or coalesce(s.scheduling_enabled, false))
      -- Pay negotiation calls only while the organisation keeps them switched on.
      and (c.purpose <> 'negotiation' or coalesce(s.negotiation_enabled, false))
      -- Never a candidate who asked not to be called by the AI assistant.
      and cand.ai_call_opt_out_at is null
      and c.due_at is not null and c.due_at <= ${now.toISOString()}::timestamptz
      -- A pay discussion call only while the discussion is unsettled (CALLABLE_NEGOTIATION).
      and (c.purpose <> 'negotiation' or exists (
        select 1 from offer_negotiations n where n.id = c.negotiation_id and n.org_id = c.org_id
          and n.status in ('open', 'message_sent', 'countered', 'call_requested', 'expired')))
      -- Scheduling and pay calls are tried at most twice (…_MAX_ATTEMPTS).
      and (c.status = 'callback'
        or c.attempt < case when c.purpose in ('scheduling', 'negotiation') then 2
          else coalesce(s.max_attempts, 3) end)
    order by c.due_at
    limit ${limit}`);
}

/** Claim one call for dialling; false if another worker got it first. */
export async function claimCall(orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(screeningCalls)
    .set({
      status: "dialling",
      // A callback the candidate asked for does not use up an attempt.
      attempt: sql`${screeningCalls.attempt} + case when ${screeningCalls.status} = 'callback' then 0 else 1 end`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(screeningCalls.id, id),
        eq(screeningCalls.orgId, orgId),
        inArray(screeningCalls.status, [...WAITING]),
        sql`not exists (select 1 from candidates c where c.id = ${screeningCalls.candidateId} and c.ai_call_opt_out_at is not null)`,
      ),
    )
    .returning({ id: screeningCalls.id });
  return rows.length === 1;
}

/**
 * Calls still "dialling" or "in progress" long after any call could have
 * ended belong to a worker that stopped: count the attempt as failed and let
 * it be retried in 15 minutes.
 */
export async function recoverStuckCalls(now: Date): Promise<number> {
  const rows = await db.execute<{ id: string; agent_run_id: string | null }>(sql`
    update screening_calls
    set status = 'failed', due_at = ${new Date(now.getTime() + 15 * 60_000).toISOString()}::timestamptz,
        last_error = 'the voice worker stopped during the call', updated_at = ${now.toISOString()}::timestamptz
    where status in ('dialling', 'in_progress')
      and updated_at < ${new Date(now.getTime() - 40 * 60_000).toISOString()}::timestamptz
    returning id, agent_run_id`);
  // Their runs end too (they hold no lease, so nothing else would close them).
  for (const r of rows as unknown as { agent_run_id: string | null }[])
    if (r.agent_run_id)
      await db.execute(sql`
        update agent_runs set status = 'failed', last_error = 'The voice worker stopped during the call.',
          finished_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
        where id = ${r.agent_run_id} and status = 'running'`);
  return rows.length;
}

export type Dispatch = { orgId: string; callId: string };

/**
 * Claim up to `capacity` calls that may be placed now. Organisations that are
 * not ready (switched off, no voice credential or phone line) or outside their
 * window are skipped — their calls wait.
 */
export async function claimDueCalls(capacity: number, now = new Date()): Promise<Dispatch[]> {
  if (capacity <= 0) return [];
  const due = await dueCalls(now);
  const orgOk = new Map<string, boolean>();
  const claimed: Dispatch[] = [];
  for (const row of due) {
    if (claimed.length >= capacity) break;
    let ok = orgOk.get(row.org_id);
    if (ok === undefined) {
      try {
        const [ready, policy] = await Promise.all([
          phoneScreeningReadiness(row.org_id),
          phoneScreeningPolicyOf(row.org_id),
        ]);
        const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
        const tz = (await getOrgEmailSettings(row.org_id)).timezone;
        ok = ready.ready && inWindow(now.getTime(), policy, tz);
      } catch (e) {
        log.warn("screening_call.org_check_failed", { org_id: row.org_id, error: e as Error });
        ok = false;
      }
      orgOk.set(row.org_id, ok);
    }
    if (!ok) continue;
    if (await claimCall(row.org_id, row.id)) claimed.push({ orgId: row.org_id, callId: row.id });
  }
  return claimed;
}
