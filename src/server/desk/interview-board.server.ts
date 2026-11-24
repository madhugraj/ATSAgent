/**
 * The hiring journey's Interviews step, per candidate: each round of the
 * role's plan with its result, the decisions and hand-overs between rounds
 * (a panel review, a hiring decision sent back for another round) and who has
 * the candidate now — so L2 → Evaluation → Interview coordinator → L3 reads
 * as one line instead of a single "Interviews" tick for the whole role.
 */
import { sql } from "drizzle-orm";

import { db } from "../db";

export type InterviewStep = {
  state: "done" | "current" | "todo" | "stopped";
  text: string;
  /** A second line: the panel agent's view, a reason given, … */
  sub?: string;
};

export type InterviewBoardRow = {
  applicationId: string;
  name: string;
  /** Who has the candidate now and what they wait for. */
  now: { text: string; tone: "decide" | "working" | "done" | "stopped"; taskId: string | null };
  steps: InterviewStep[];
};

type Round = { level: number; name: string };
type Interview = {
  level: number;
  status: string;
  scheduledAt: Date | null;
  completedAt: Date | null;
  interviewer: string | null;
};
/** How a round's time is being agreed: the panel's answers, then the candidate's. */
type Arranging = {
  level: number;
  slots: Date[];
  panel: { name: string; state: string; okSlots: Date[] }[];
  call: { status: string; endReason: string | null; since: Date } | null;
  emailedAt: Date | null;
  chosenAt: Date | null;
  candidate: { state: string } | null;
};
type Score = { level: number; evaluator: string; rating: number | null; verdict: string | null };
type Assessment = {
  level: number;
  rating: number | null;
  verdict: string | null;
  outcome: string | null;
  reviewDecision: string | null;
};
type Task = {
  id: string;
  agentType: string;
  title: string;
  status: string;
  subject: string | null;
  reason: string | null;
  createdAt: Date;
};

const VERDICT: Record<string, string> = { select: "select", hold: "hold", reject: "reject" };
const REVIEW: Record<string, string> = {
  go_with_panel: "HR head went with the panel",
  confirmed: "HR head confirmed the panel",
  held: "HR head put the candidate on hold",
  rejected: "HR head stopped the candidate",
};

function roundResult(scores: Score[]): string {
  if (!scores.length) return "";
  const ratings = scores.map((s) => s.rating).filter((r): r is number => r != null);
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const verdicts = [...new Set(scores.map((s) => s.verdict).filter(Boolean))] as string[];
  const verdict = verdicts.includes("reject")
    ? "reject"
    : verdicts.includes("hold")
      ? "hold"
      : verdicts[0];
  return [
    scores.map((s) => s.evaluator).join(", "),
    [verdict ? VERDICT[verdict] : null, avg != null ? `${Math.round(avg * 10) / 10}/5` : null]
      .filter(Boolean)
      .join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
}

const CALL: Record<string, string> = {
  approved: "AI scheduling call not placed yet",
  dialling: "AI scheduling call ringing now",
  in_progress: "on the AI scheduling call now",
  no_answer: "did not answer the AI scheduling call — it will try again",
  callback: "asked to be called back",
  fell_back: "the call did not settle a time — times e-mailed",
  failed: "the AI scheduling call failed — times e-mailed",
};

/** Who has agreed the time so far, one line for the panel and one for the candidate. */
function arrangingLines(
  a: Arranging,
  candidate: string,
  when: (d: Date) => string,
): { lines: string[]; now: string } {
  const lines: string[] = [];
  const panelDone = a.panel.length > 0 && a.panel.every((p) => p.state === "accepted");
  for (const p of a.panel)
    lines.push(
      p.state === "accepted"
        ? `${p.name} accepted ${p.okSlots.length ? p.okSlots.map(when).join(", ") : "the time"}`
        : p.state === "superseded"
          ? `${p.name} was replaced`
          : `${p.name} has not answered yet`,
    );
  const first = candidate.split(" ")[0] ?? candidate;
  let now: string;
  if (a.chosenAt || a.candidate?.state === "accepted") {
    lines.push(`${first} confirmed the time`);
    now = "Time agreed — the interview is being booked";
  } else if (!panelDone) {
    now = `Waiting for the panel to accept a time`;
  } else if (a.call && CALL[a.call.status]) {
    const since = a.call.status === "approved" ? ` (since ${when(a.call.since)})` : "";
    lines.push(`${first}: ${CALL[a.call.status]}${since}`);
    now = `Panel accepted — waiting for ${first}`;
  } else if (a.emailedAt) {
    lines.push(`${first}: times e-mailed ${when(a.emailedAt)}, no pick yet`);
    now = `Panel accepted — waiting for ${first} to pick a time`;
  } else {
    lines.push(`${first}: not contacted yet`);
    now = `Panel accepted — ${first} not contacted yet`;
  }
  return { lines, now };
}

/** One candidate's row, from what is stored (pure; unit-tested). */
export function interviewRow(input: {
  applicationId: string;
  name: string;
  stage: string;
  rounds: Round[];
  interviews: Interview[];
  scores: Score[];
  assessments: Assessment[];
  offered: number[];
  arranging?: Arranging[];
  tasks: Task[];
  activeAgent: string | null;
  agentTitle: (t: string) => string;
  when: (d: Date) => string;
}): InterviewBoardRow {
  const steps: InterviewStep[] = [];
  const stopped = ["rejected", "withdrawn", "on_hold"].includes(input.stage);
  const decisions = input.tasks
    .filter(
      (t) =>
        (t.subject === "hiring_decision" && t.status !== "cancelled") ||
        (t.subject === "round_addition" && t.status !== "cancelled"),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // A round nobody held because the candidate went straight to a later one.
  const furthest = Math.max(
    0,
    ...input.interviews.map((i) => i.level),
    ...input.scores.map((s) => s.level),
  );
  let nowText: string | null = null;
  const completedAt = (level: number) =>
    input.interviews.find((i) => i.level === level && i.status === "completed")?.completedAt ??
    null;
  let reachedCurrent = false;
  for (const r of input.rounds) {
    const iv = input.interviews.find((i) => i.level === r.level);
    const scores = input.scores.filter((s) => s.level === r.level);
    const label = `L${r.level} ${r.name}`;
    const done = iv?.status === "completed" || (scores.length > 0 && !iv);
    let step: InterviewStep;
    if (done) {
      step = { state: "done", text: [label, roundResult(scores)].filter(Boolean).join(" · ") };
      const a = input.assessments.find((x) => x.level === r.level);
      if (a?.verdict && a.outcome && a.outcome !== "agree")
        step.sub = `L${r.level} panel agent: ${a.verdict} ${a.rating ?? "–"}/5 → ${
          a.reviewDecision ? REVIEW[a.reviewDecision] : "waiting for the HR head's review"
        }`;
    } else if (!iv && r.level < furthest) {
      step = { state: "todo", text: `${label} · not held` };
    } else if (!reachedCurrent && !stopped) {
      reachedCurrent = true;
      const booked = iv?.status === "scheduled" || iv?.status === "rescheduled";
      const where = booked
        ? iv!.scheduledAt
          ? `booked ${input.when(iv!.scheduledAt)}${iv!.interviewer ? ` with ${iv!.interviewer}` : ""}`
          : "booked"
        : input.offered.includes(r.level)
          ? "times offered to the candidate"
          : "being arranged";
      const past = booked && iv!.scheduledAt != null && iv!.scheduledAt.getTime() < Date.now();
      nowText = past
        ? `Waiting for the L${r.level} scorecard`
        : booked
          ? `Waiting for the L${r.level} interview`
          : input.offered.includes(r.level)
            ? `The candidate is picking an L${r.level} time`
            : `Interview coordinator is arranging L${r.level}`;
      const arr = !booked ? input.arranging?.find((x) => x.level === r.level) : undefined;
      const agreeing = arr ? arrangingLines(arr, input.name, input.when) : null;
      if (agreeing) nowText = agreeing.now;
      step = {
        state: "current",
        text: `${label} · ${agreeing ? "agreeing a time" : where}`,
        ...(past
          ? { sub: "The time has passed and no scorecard is in yet." }
          : agreeing
            ? { sub: agreeing.lines.join("\n") }
            : {}),
      };
    } else {
      step = { state: stopped ? "stopped" : "todo", text: label };
    }
    steps.push(step);
    // Decisions asked after this round (and before the next one was held) sit here.
    const doneAt = completedAt(r.level);
    const nextDoneAt = completedAt(r.level + 1);
    if (done)
      for (const d of decisions) {
        const t = d.createdAt.getTime();
        if (doneAt && t < doneAt.getTime()) continue;
        if (nextDoneAt && t > nextDoneAt.getTime()) continue;
        if (!doneAt && r.level !== input.rounds.at(-1)?.level) continue;
        if (d.subject === "round_addition") {
          steps.push({
            state: d.status === "open" ? "current" : d.status === "approved" ? "done" : "todo",
            text:
              d.status === "open"
                ? "Evaluation · another round waiting for the hiring manager"
                : d.status === "approved"
                  ? `Hiring manager added L${r.level + 1}`
                  : "Hiring manager declined another round",
          });
          continue;
        }
        steps.push({
          state: d.status === "open" ? "current" : "done",
          text:
            d.status === "open"
              ? "Evaluation · hiring decision waiting for the hiring manager"
              : d.status === "approved"
                ? "Evaluation · hiring decision approved"
                : "Evaluation · hiring decision sent back",
          ...(d.status === "rejected" && d.reason ? { sub: `“${d.reason}”` } : {}),
        });
      }
  }
  const open = input.tasks
    .filter((t) => t.status === "open")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const current = steps.find((s) => s.state === "current");
  const now: InterviewBoardRow["now"] = stopped
    ? { text: `Stopped (${input.stage.replace("_", " ")})`, tone: "stopped", taskId: null }
    : open
      ? {
          text: `${input.agentTitle(open.agentType)} — ${open.title} · waiting for you`,
          tone: "decide",
          taskId: open.id,
        }
      : input.activeAgent
        ? {
            text: `${input.agentTitle(input.activeAgent)} is working`,
            tone: "working",
            taskId: null,
          }
        : current
          ? { text: nowText ?? current.text, tone: "working", taskId: null }
          : { text: "Every round is done", tone: "done", taskId: null };
  return { applicationId: input.applicationId, name: input.name, now, steps };
}

/** Everyone of the role who has reached an interview round. */
export async function interviewBoard(
  orgId: string,
  requisitionId: string,
  helpers: { agentTitle: (t: string) => string; when: (d: Date) => string },
): Promise<InterviewBoardRow[]> {
  const apps = (await db.execute(sql`
    select a.id, c.full_name as name, a.stage::text as stage
    from applications a join candidates c on c.id = a.candidate_id
    where a.org_id = ${orgId} and a.requisition_id = ${requisitionId}
      and a.stage::text not in ('withdrawn')
      and exists (select 1 from interviews i where i.application_id = a.id and i.org_id = ${orgId}
        and i.status not in ('cancelled'))
    order by c.full_name limit 30`)) as unknown as { id: string; name: string; stage: string }[];
  if (!apps.length) return [];
  const ids = apps.map((a) => a.id);
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { planFor } = await import("@/lib/interview-plan.server");
  const { plan } = await planFor(orgId, requisitionId);
  const interviews = (await db.execute(sql`
    select distinct on (application_id, level) application_id, level, status, scheduled_at,
      completed_at, interviewer
    from interviews where org_id = ${orgId} and application_id in (${idList})
      and status not in ('cancelled', 'no_show')
    order by application_id, level,
      case status when 'completed' then 0 when 'scheduled' then 1 when 'rescheduled' then 1 else 2 end,
      created_at desc`)) as unknown as {
    application_id: string;
    level: number;
    status: string;
    scheduled_at: string | null;
    completed_at: string | null;
    interviewer: string | null;
  }[];
  const scores = (await db.execute(sql`
    select application_id, level, coalesce(nullif(evaluator, ''), evaluator_email) evaluator,
      rating, recommendation
    from evaluations where org_id = ${orgId} and application_id in (${idList})
    order by created_at`)) as unknown as {
    application_id: string;
    level: number;
    evaluator: string;
    rating: number | null;
    recommendation: string | null;
  }[];
  const assessments = (await db.execute(sql`
    select application_id, level, rating, verdict, outcome, review_decision
    from panel_assessments where org_id = ${orgId} and application_id in (${idList})`)) as unknown as {
    application_id: string;
    level: number;
    rating: number | null;
    verdict: string | null;
    outcome: string | null;
    review_decision: string | null;
  }[];
  const offered = (await db.execute(sql`
    select distinct application_id, level from interview_slot_offers
    where org_id = ${orgId} and application_id in (${idList}) and status = 'offered'`)) as unknown as {
    application_id: string;
    level: number;
  }[];
  const offers = (await db.execute(sql`
    select distinct on (o.application_id, o.level) o.id, o.application_id, o.level, o.slots,
      o.chosen_at, o.link_emailed_at
    from interview_slot_offers o
    where o.org_id = ${orgId} and o.application_id in (${idList}) and o.status in ('offered', 'booked')
    order by o.application_id, o.level, o.created_at desc`)) as unknown as {
    id: string;
    application_id: string;
    level: number;
    slots: string[] | null;
    chosen_at: string | null;
    link_emailed_at: string | null;
  }[];
  const offerIds = offers.map((o) => o.id);
  const confirmations = offerIds.length
    ? ((await db.execute(sql`
        select offer_id, party, coalesce(nullif(name, ''), email) as name, state, ok_slots
        from interview_confirmations
        where org_id = ${orgId} and offer_id in (${sql.join(
          offerIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        order by created_at`)) as unknown as {
        offer_id: string;
        party: string;
        name: string;
        state: string;
        ok_slots: string[] | null;
      }[])
    : [];
  const calls = offerIds.length
    ? ((await db.execute(sql`
        select distinct on (slot_offer_id) slot_offer_id, status, end_reason, created_at
        from screening_calls
        where org_id = ${orgId} and purpose = 'scheduling' and slot_offer_id in (${sql.join(
          offerIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        order by slot_offer_id, created_at desc`)) as unknown as {
        slot_offer_id: string;
        status: string;
        end_reason: string | null;
        created_at: string;
      }[])
    : [];
  const tasks = (await db.execute(sql`
    select t.id, r.agent_type, t.title, t.status, t.created_at,
      t.proposed_action -> 'args' -> 'subject' ->> 'type' as subject,
      t.response ->> 'reason' as reason,
      coalesce(t.proposed_action -> 'args' -> 'subject' ->> 'applicationId',
        t.proposed_action -> 'args' ->> 'applicationId',
        case when r.subject_type = 'application' then r.subject_id::text end) as application_id
    from agent_tasks t join agent_runs r on r.id = t.run_id
    where t.org_id = ${orgId} and r.org_id = ${orgId}
      and coalesce(t.proposed_action -> 'args' -> 'subject' ->> 'applicationId',
        t.proposed_action -> 'args' ->> 'applicationId',
        case when r.subject_type = 'application' then r.subject_id::text end)
        in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)) as unknown as {
    id: string;
    agent_type: string;
    title: string;
    status: string;
    created_at: string;
    subject: string | null;
    reason: string | null;
    application_id: string;
  }[];
  const active = (await db.execute(sql`
    select distinct on (subject_id) subject_id, agent_type from agent_runs
    where org_id = ${orgId} and subject_type = 'application' and subject_id in (${idList})
      and status in ('queued', 'running')
    order by subject_id, created_at desc`)) as unknown as {
    subject_id: string;
    agent_type: string;
  }[];
  const rounds = plan.rounds.map((r) => ({ level: r.level, name: r.name }));
  // Scorecards keep an e-mail (or "external:<e-mail>"); show the person's name.
  const people = (await db.execute(sql`
    select lower(email) email, full_name name from panelists where org_id = ${orgId}
    union all
    select lower(email), full_name from org_members where org_id = ${orgId} and full_name <> ''`)) as unknown as {
    email: string;
    name: string | null;
  }[];
  const nameOf = (who: string) => {
    const e = who.replace(/^external:/, "").toLowerCase();
    return (
      people.find((p) => p.email === e && p.name)?.name ??
      (e.includes("@") ? e.split("@")[0]! : who)
    );
  };
  return apps.map((a) =>
    interviewRow({
      applicationId: a.id,
      name: a.name,
      stage: a.stage,
      rounds,
      interviews: interviews
        .filter((i) => i.application_id === a.id)
        .map((i) => ({
          level: i.level,
          status: i.status,
          scheduledAt: i.scheduled_at ? new Date(i.scheduled_at) : null,
          completedAt: i.completed_at ? new Date(i.completed_at) : null,
          interviewer: i.interviewer,
        })),
      scores: scores
        .filter((s) => s.application_id === a.id)
        .map((s) => ({
          level: s.level,
          evaluator: nameOf(s.evaluator),
          rating: s.rating,
          verdict: s.recommendation,
        })),
      assessments: assessments
        .filter((x) => x.application_id === a.id)
        .map((x) => ({
          level: x.level,
          rating: x.rating,
          verdict: x.verdict,
          outcome: x.outcome,
          reviewDecision: x.review_decision,
        })),
      offered: offered.filter((o) => o.application_id === a.id).map((o) => o.level),
      arranging: offers
        .filter((o) => o.application_id === a.id)
        .map((o) => {
          const conf = confirmations.filter((c) => c.offer_id === o.id);
          const call = calls.find((c) => c.slot_offer_id === o.id);
          const cand = conf.filter((c) => c.party === "candidate").at(-1);
          return {
            level: o.level,
            slots: (o.slots ?? []).map((x) => new Date(x)),
            panel: conf
              .filter((c) => c.party === "panelist")
              .map((c) => ({
                name: nameOf(c.name),
                state: c.state,
                okSlots: (c.ok_slots ?? []).map((x) => new Date(x)),
              })),
            call: call
              ? {
                  status: call.status,
                  endReason: call.end_reason,
                  since: new Date(call.created_at),
                }
              : null,
            emailedAt: o.link_emailed_at ? new Date(o.link_emailed_at) : null,
            chosenAt: o.chosen_at ? new Date(o.chosen_at) : null,
            candidate: cand ? { state: cand.state } : null,
          };
        }),
      tasks: tasks
        .filter((t) => t.application_id === a.id)
        .map((t) => ({
          id: t.id,
          agentType: t.agent_type,
          title: t.title,
          status: t.status,
          subject: t.subject,
          reason: t.reason,
          createdAt: new Date(t.created_at),
        })),
      activeAgent: active.find((r) => r.subject_id === a.id)?.agent_type ?? null,
      agentTitle: helpers.agentTitle,
      when: helpers.when,
    }),
  );
}
