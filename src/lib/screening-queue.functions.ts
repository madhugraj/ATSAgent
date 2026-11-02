/**
 * Org-scoped read layer for the screening triage queue.
 *
 * Replaces the old pattern of shipping the org's entire candidates /
 * applications / kits / runs tables to the browser and joining client-side.
 * `listScreeningQueue` returns slim, already-joined pages (50 rows) with true
 * per-bucket counts; `getScreeningCandidate` returns the one candidate the
 * recruiter is looking at. Nothing heavy ever reaches the wire: no resume
 * text, no match rationale beyond the selected candidate's evidence block,
 * no engine/model fields, no prep-job internals beyond the coarse status.
 */
import { and, desc, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, matchScores, requisitions } from "@db/schema";
import { requireOrg } from "./auth.middleware";

/** JSON-safe value — what a server function is allowed to return. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** camelCase drizzle row → PostgREST-style snake_case row with ISO dates. */
function snakeRow(row: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] =
      value instanceof Date ? value.toISOString() : (value as Json);
  }
  return out;
}

export type ScreeningBucket = "to_call" | "ready" | "graded" | "all";

/**
 * Buckets over ACTIVE applications (joined / hired / rejected / withdrawn /
 * offer_declined / no_show are excluded everywhere):
 *  - `to_call`  — shortlisted-or-later, no kit yet. Sourced/applied/
 *                 ai_screened rows are deliberately NOT here (a screening
 *                 call presupposes a shortlist decision); they surface only
 *                 in `all`, and only they are auto-prepped.
 *  - `ready`    — a kit exists, no graded call yet.
 *  - `graded`   — latest call has a verdict.
 *  - `all`      — everything active, including pre-shortlist stages and
 *                 parked candidates (on_hold / reserve / joining_deferred).
 */
const BUCKET_CASE = sql`
  case
    when run.candidate_id is not null then 'graded'
    when k.id is not null then 'ready'
    when ac.stage in ('shortlisted','l1','l2','l3','offer_pending','offer_released','offer_accepted')
      then 'to_call'
    else 'pre_queue'
  end`;

/**
 * Shared CTE stack: active applications (org/req/term filtered), the latest
 * match score / kit / run per pairing, then the bucket assignment. Kit and
 * run join on the (candidate_id, requisition_id) pairing — runs'
 * application_id is nullable and kits can predate their application — and
 * (requisition_id, candidate_id) is unique on applications, so the pairing is
 * 1:1 with the application row.
 */
function queueCtes(orgId: string, requisitionId: string | null, termPattern: string) {
  return sql`
    with active as (
      select a.id as application_id, a.candidate_id, a.requisition_id,
             a.stage::text as stage, a.source::text as source, a.applied_at,
             c.full_name as candidate_name, c.email, c.location,
             c.experience_years,
             r.title as requisition_title, r.code as requisition_code
      from applications a
      join candidates c on c.id = a.candidate_id
      join requisitions r on r.id = a.requisition_id
      where a.org_id = ${orgId}
        and a.stage::text not in ('joined','hired','rejected','withdrawn','offer_declined','no_show')
        and (${requisitionId}::uuid is null or a.requisition_id = ${requisitionId}::uuid)
        and (
          ${termPattern} = ''
          or c.full_name ilike ${termPattern}
          or c.email ilike ${termPattern}
          or r.title ilike ${termPattern}
          or r.code ilike ${termPattern}
        )
    ),
    latest_match as (
      select distinct on (application_id) application_id, overall_score
      from match_scores
      where org_id = ${orgId}
      order by application_id, computed_at desc
    ),
    latest_kit as (
      select distinct on (candidate_id, requisition_id) candidate_id, requisition_id, id
      from screening_kits
      where org_id = ${orgId} and requisition_id is not null
      order by candidate_id, requisition_id, created_at desc
    ),
    latest_run as (
      select distinct on (candidate_id, requisition_id)
             candidate_id, requisition_id,
             screening_score, combined_score, recommendation, red_flags
      from screening_runs
      where org_id = ${orgId} and requisition_id is not null
      order by candidate_id, requisition_id, created_at desc
    ),
    bucketed as (
      select ac.*,
             m.overall_score as match_score,
             (k.id is not null) as kit_ready,
             p.status as prep_status,
             run.screening_score, run.combined_score, run.recommendation,
             coalesce(array_length(run.red_flags, 1), 0) as red_flag_count,
             ${BUCKET_CASE} as bucket
      from active ac
      left join latest_match m on m.application_id = ac.application_id
      left join latest_kit k
        on k.candidate_id = ac.candidate_id and k.requisition_id = ac.requisition_id
      left join latest_run run
        on run.candidate_id = ac.candidate_id and run.requisition_id = ac.requisition_id
      left join screening_prep_jobs p on p.application_id = ac.application_id
    )`;
}

/**
 * postgres-js returns a row-list Array (drizzle passes it through); accept
 * either shape defensively — an empty queue must never look like a query bug.
 */
function execRows(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  const r = res as { rows?: Record<string, unknown>[] } | null;
  return r?.rows ?? [];
}

/** Wire-safe scalar: Date → ISO string, everything else passes through. */
function wire(value: unknown): Json {
  return value instanceof Date ? value.toISOString() : (value as Json);
}

/** One pre-joined queue row — deliberately slim (no resume text, no rationale). */
export type ScreeningQueueRow = {
  application_id: string;
  candidate_id: string;
  requisition_id: string;
  stage: string;
  source: string | null;
  applied_at: string;
  candidate_name: string;
  email: string | null;
  location: string | null;
  experience_years: number | string | null;
  requisition_title: string;
  requisition_code: string | null;
  match_score: number | null;
  kit_ready: boolean;
  prep_status: "pending" | "running" | "ready" | "failed" | null;
  screening_score: number | null;
  combined_score: number | null;
  recommendation: string | null;
  red_flag_count: number;
  bucket: "to_call" | "ready" | "graded" | "pre_queue";
};

/** Raw SQL row before wire-normalisation (applied_at may arrive as a Date). */
type QueueSqlRow = Omit<ScreeningQueueRow, "applied_at" | "red_flag_count"> & {
  applied_at: unknown;
  red_flag_count: unknown;
};

export const listScreeningQueue = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid().nullable().optional(),
        bucket: z.enum(["to_call", "ready", "graded", "all"]),
        term: z.string().max(120).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    // Only filters inside the org predicate — a client-supplied requisitionId
    // can never widen the scope (the loadPairing discipline).
    const requisitionId = data.requisitionId ?? null;
    // Users cannot widen the ilike with wildcards; case-insensitive match only.
    const clean = (data.term ?? "").trim().replace(/[%_\\]/g, "");
    const termPattern = clean ? `%${clean}%` : "";

    const ctes = queueCtes(context.orgId, requisitionId, termPattern);

    // Whitelist-composed ordering: best match first, graded by combined fit;
    // stable application_id tiebreak keeps infinite-scroll pages overlap-free.
    const order =
      data.bucket === "graded"
        ? sql`combined_score desc nulls last`
        : sql`match_score desc nulls last`;

    const rowsResult = await db.execute(
      sql`${ctes}
        select * from bucketed
        where (${data.bucket} = 'all' or bucket = ${data.bucket})
        order by ${order}, application_id
        offset ${data.offset} limit ${data.limit}`,
    );
    const rows = execRows(rowsResult) as unknown as QueueSqlRow[];

    const counts = await bucketCounts(context.orgId, requisitionId, termPattern);

    return {
      rows: rows.map((r): ScreeningQueueRow => ({
        application_id: r.application_id,
        candidate_id: r.candidate_id,
        requisition_id: r.requisition_id,
        stage: r.stage,
        source: r.source,
        applied_at: wire(r.applied_at) as string,
        candidate_name: r.candidate_name,
        email: r.email,
        location: r.location,
        experience_years: r.experience_years,
        requisition_title: r.requisition_title,
        requisition_code: r.requisition_code,
        match_score: r.match_score,
        kit_ready: r.kit_ready,
        prep_status: r.prep_status,
        screening_score: r.screening_score,
        combined_score: r.combined_score,
        recommendation: r.recommendation,
        red_flag_count: Number(r.red_flag_count ?? 0),
        bucket: r.bucket,
      })),
      counts,
      total: counts.all,
    };
  });

export type ScreeningQueueCounts = {
  to_call: number;
  ready: number;
  graded: number;
  all: number;
};

/** The bucket aggregate over the SAME cte stack the rows use — counts can never
 * diverge from what the queue page shows. Dashboard strip calls this with no
 * filters; the queue page passes its own requisition/term filters. */
async function bucketCounts(
  orgId: string,
  requisitionId: string | null,
  termPattern: string,
): Promise<ScreeningQueueCounts> {
  const res = await db.execute(sql`${queueCtes(orgId, requisitionId, termPattern)}
    select bucket, count(*)::int as n
    from bucketed
    group by bucket`);
  const countRows = execRows(res) as unknown as { bucket: string; n: number }[];
  const byBucket = new Map(countRows.map((c) => [c.bucket, c.n]));
  return {
    to_call: byBucket.get("to_call") ?? 0,
    ready: byBucket.get("ready") ?? 0,
    graded: byBucket.get("graded") ?? 0,
    all: countRows.reduce((acc, c) => acc + c.n, 0),
  };
}

/** Dashboard "Needs you today": bucket counts only — no rows shipped. */
export const screeningQueueCounts = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<ScreeningQueueCounts> =>
    bucketCounts(context.orgId, null, ""),
  );

/* ------------------------------------------------ selected candidate pane */

export const getScreeningCandidate = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z.object({ candidateId: z.string().uuid(), applicationId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    // The application must belong to the caller's org AND to this candidate.
    const [app] = await db
      .select({
        id: applications.id,
        stage: applications.stage,
        appliedAt: applications.appliedAt,
        requisitionId: applications.requisitionId,
        requisitionTitle: requisitions.title,
        requisitionCode: requisitions.code,
      })
      .from(applications)
      .innerJoin(requisitions, eq(applications.requisitionId, requisitions.id))
      .where(
        and(
          eq(applications.id, data.applicationId),
          eq(applications.candidateId, data.candidateId),
          eq(applications.orgId, context.orgId),
        ),
      )
      .limit(1);
    if (!app) throw new Error("Application not found");

    const [candidate] = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, data.candidateId), eq(candidates.orgId, context.orgId)))
      .limit(1);
    if (!candidate) throw new Error("Candidate not found");

    // Evidence block for the pane — a projection, never the raw score row.
    const [match] = await db
      .select({
        overallScore: matchScores.overallScore,
        rationale: matchScores.rationale,
        matchedSkills: matchScores.matchedSkills,
        missingSkills: matchScores.missingSkills,
        riskFlags: matchScores.riskFlags,
        recommendation: matchScores.recommendation,
        computedAt: matchScores.computedAt,
      })
      .from(matchScores)
      .where(eq(matchScores.applicationId, data.applicationId))
      .orderBy(desc(matchScores.computedAt))
      .limit(1);

    // Every pairing this candidate is in, for ScreeningPanel's role switcher.
    const roleRows = await db
      .select({
        id: applications.id,
        stage: applications.stage,
        appliedAt: applications.appliedAt,
        requisitionId: applications.requisitionId,
        requisitionTitle: requisitions.title,
      })
      .from(applications)
      .innerJoin(requisitions, eq(applications.requisitionId, requisitions.id))
      .where(
        and(eq(applications.candidateId, data.candidateId), eq(applications.orgId, context.orgId)),
      )
      .orderBy(desc(applications.appliedAt));

    // resume_text is dropped on purpose: the pane renders parsed data and a
    // download button (getResumeDownloadUrl), and one candidate's CV text has
    // no business riding along with every queue selection.
    const { resumeText: _drop, ...candidateRest } = candidate;

    return {
      candidate: snakeRow(candidateRest),
      application: {
        id: app.id,
        stage: app.stage,
        applied_at: app.appliedAt instanceof Date ? app.appliedAt.toISOString() : app.appliedAt,
        requisition_id: app.requisitionId,
        requisition_title: app.requisitionTitle,
        requisition_code: app.requisitionCode,
      },
      match: match
        ? {
            overall_score: match.overallScore,
            rationale: match.rationale,
            matched_skills: match.matchedSkills,
            missing_skills: match.missingSkills,
            risk_flags: match.riskFlags,
            recommendation: match.recommendation,
            computed_at:
              match.computedAt instanceof Date ? match.computedAt.toISOString() : match.computedAt,
          }
        : null,
      roles: roleRows.map((r) => ({
        application_id: r.id,
        requisition_id: r.requisitionId,
        title: r.requisitionTitle,
        stage: r.stage,
      })),
    };
  });
