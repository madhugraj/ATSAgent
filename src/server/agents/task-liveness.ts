/**
 * Is an open agent request (agent_tasks) still something a person can decide?
 *
 * A request outlives its purpose when its run stops (cancelled, failed, done)
 * or when what it is about — the run's subject, or a record its proposed
 * action names — is deleted or erased. Such a request must not be reminded
 * about, shown as waiting, or "approved" into nothing. These SQL fragments are
 * the one definition every reader uses; they expect `agent_tasks` joined to
 * its `agent_runs` row.
 */
import { and, eq, inArray, not, sql, type SQL } from "drizzle-orm";

import { agentRuns, agentTasks } from "@db/schema";

/** Run statuses that can still pick up a decision. */
export const LIVE_RUN_STATUSES = ["queued", "running", "awaiting_human"] as const;

const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** A jsonb text value as a uuid, or null when it is not one (never a cast error). */
function asUuid(text: SQL): SQL {
  return sql`(case when (${text}) ~* ${UUID_RE} then (${text})::uuid end)`;
}

function missing(table: string, id: SQL): SQL {
  return sql`(${id} is not null and not exists (select 1 from ${sql.raw(table)} x where x.id = ${id}))`;
}

const args = sql`(${agentTasks.proposedAction} -> 'args')`;
const subject = sql`(${args} -> 'subject')`;

const runSubject = (type: string, table: string) =>
  sql`(${agentRuns.subjectType} = ${type} and ${missing(table, sql`${agentRuns.subjectId}`)})`;

/** The run's own subject (requisition, application, JD or offer) has been deleted. */
export function runSubjectGone(): SQL {
  return sql`(${runSubject("requisition", "requisitions")}
    or ${runSubject("application", "applications")}
    or ${runSubject("jd", "job_descriptions")}
    or ${runSubject("offer", "offers")})`;
}

/**
 * What the request was about that no longer exists ("the requisition", …),
 * or null while everything it refers to is still there.
 */
export function goneSubjectLabel(): SQL<string | null> {
  const recordSubject = (type: string, table: string) =>
    sql`(${subject} ->> 'type' = ${type} and ${missing(table, asUuid(sql`${subject} ->> 'id'`))})`;
  // A rejection batch is gone once none of its candidates' applications remain.
  const rejectionGone = sql`(${subject} ->> 'type' = 'rejection'
    and jsonb_typeof(${subject} -> 'items') = 'array'
    and jsonb_array_length(${subject} -> 'items') > 0
    and not exists (
      select 1 from jsonb_array_elements(${subject} -> 'items') it
      join applications a on a.id = ${asUuid(sql`it ->> 'applicationId'`)}
    ))`;
  const checks: [string, SQL][] = [
    ["the requisition", runSubject("requisition", "requisitions")],
    ["the candidate's application", runSubject("application", "applications")],
    ["the job description", runSubject("jd", "job_descriptions")],
    ["the offer", runSubject("offer", "offers")],
    ["the requisition", recordSubject("requisition", "requisitions")],
    ["the job description", recordSubject("jd", "job_descriptions")],
    ["the offer", recordSubject("offer", "offers")],
    ["the candidates' applications", rejectionGone],
    [
      "the candidate's application",
      missing("applications", asUuid(sql`${subject} ->> 'applicationId'`)),
    ],
    ["the offer", missing("offers", asUuid(sql`${subject} ->> 'offerId'`))],
    ["the requisition", missing("requisitions", asUuid(sql`${args} ->> 'requisitionId'`))],
    [
      "the candidate's application",
      missing("applications", asUuid(sql`${args} ->> 'applicationId'`)),
    ],
    ["the offer", missing("offers", asUuid(sql`${args} ->> 'offerId'`))],
    ["the candidate", missing("candidates", asUuid(sql`${args} ->> 'candidateId'`))],
  ];
  return sql<string | null>`(case ${sql.join(
    checks.map(([label, cond]) => sql`when ${cond} then ${label}`),
    sql` `,
  )} end)`;
}

/** True when something the request refers to has been deleted or erased. */
export function subjectGone(): SQL {
  return sql`(${goneSubjectLabel()} is not null)`;
}

/** The request can still be decided: its run is live and its subject exists. */
export function taskIsLive(): SQL {
  return and(inArray(agentRuns.status, [...LIVE_RUN_STATUSES]), not(subjectGone()))!;
}

/**
 * Worth reminding a person about: the run is parked waiting for people and
 * the subject exists. (A run that is mid-turn or queued is not waiting yet.)
 */
export function taskIsRemindable(): SQL {
  return and(eq(agentRuns.status, "awaiting_human"), not(subjectGone()))!;
}

/** Plain-language reason a request no longer applies, or null while it does. */
export function staleReasonSql(): SQL<string | null> {
  return sql<string | null>`(case
    when ${subjectGone()} then ${goneSubjectLabel()} || ' it was about has been deleted'
    when ${agentRuns.status} = 'cancelled' then 'the agent working on it was stopped'
    when ${agentRuns.status} = 'failed' then 'the agent working on it stopped with an error'
    when ${agentRuns.status} = 'done' then 'the agent working on it has already finished'
  end)`;
}
