/**
 * Where a role can be published, how much supply it is getting, and who the
 * organisation already knows that could fill it (docs/agentic-plan.md §13.4).
 *
 * - publishChannels: every channel with its real state — the internal job
 *   board, the public apply link, the careers inbox and each job board
 *   (connected? enabled? may this connection post? already live?) — so the
 *   Publishing agent publishes where it can and says plainly where it cannot.
 * - roleTraction: applicants by channel, the last 7 days, shortlist depth and
 *   whether the role is starving, by explicit thresholds (SOURCING).
 * - pastCandidates: people who did well for other roles (reached a shortlist
 *   or an interview, or were held in reserve), consented, are not in this
 *   pipeline and were not invited for it recently — ranked against this
 *   role's must-haves.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import {
  applications,
  candidates,
  organizations,
  requisitionBoardPostings,
  requisitions,
} from "@db/schema";
import { env } from "../env";

/** Explicit thresholds, so every "starving" verdict is explainable. */
export const SOURCING = {
  /** A role live this many days… */
  minDaysLive: 3,
  /** …with fewer applicants than this in the last 7 days is starving. */
  minApplicants7d: 5,
  /** Shortlisted candidates wanted per opening. */
  shortlistPerOpening: 3,
  /** At most one sourcing run per role in this many hours (sweep). */
  cooldownHours: 24,
  /** A past candidate is not re-invited to the same role within this many days. */
  reinviteDays: 30,
} as const;

/** Sources added by agents themselves (reported by the agent, not announced as arrivals). */
export const AGENT_SOURCES = ["agent_talent_pool"] as const;

const BOARDS = ["linkedin", "naukri", "indeed"] as const;

export function applyUrl(requisitionId: string): string {
  return `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/apply/${requisitionId}`;
}

async function loadRole(orgId: string, requisitionId: string) {
  const [r] = await db
    .select({
      id: requisitions.id,
      code: requisitions.code,
      title: requisitions.title,
      status: requisitions.status,
      openings: requisitions.openings,
      location: requisitions.location,
      mustHave: requisitions.mustHaveSkills,
      experienceMin: requisitions.experienceMin,
      experienceMax: requisitions.experienceMax,
      ijpEnabled: requisitions.ijpEnabled,
      ijpPostedAt: requisitions.ijpPostedAt,
    })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!r) throw new Error("Requisition not found.");
  return r;
}

export type BoardChannel = {
  provider: (typeof BOARDS)[number];
  connected: boolean;
  enabled: boolean;
  canPost: boolean;
  /** Why it cannot post, in plain words (from the board's own capability check). */
  detail: string | null;
  live: { status: string; url: string | null; publishedAt: string | null } | null;
};

export type PublishChannels = {
  requisition: { code: string; title: string; status: string };
  applyUrl: string;
  careersInbox: string | null;
  internal: { live: boolean; postedAt: string | null };
  boards: BoardChannel[];
};

export async function publishChannels(
  orgId: string,
  requisitionId: string,
): Promise<PublishChannels> {
  const r = await loadRole(orgId, requisitionId);
  const [org] = await db
    .select({ inboxSlug: organizations.inboxSlug, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const { inboxAddress } = await import("@/lib/local-inbox.server");
  const postings = await db
    .select({
      provider: requisitionBoardPostings.provider,
      status: requisitionBoardPostings.status,
      url: requisitionBoardPostings.externalUrl,
      publishedAt: requisitionBoardPostings.publishedAt,
    })
    .from(requisitionBoardPostings)
    .where(
      and(
        eq(requisitionBoardPostings.requisitionId, requisitionId),
        eq(requisitionBoardPostings.orgId, orgId),
      ),
    );
  const { getBoardAdapter, loadBoardConnection } = await import("../boards/registry");
  const boards: BoardChannel[] = [];
  for (const provider of BOARDS) {
    const p = postings.find((x) => x.provider === provider);
    const live =
      p && p.status === "published"
        ? { status: p.status, url: p.url, publishedAt: p.publishedAt?.toISOString() ?? null }
        : null;
    let connected = false;
    let enabled = false;
    let canPost = false;
    let detail: string | null = null;
    try {
      const conn = await loadBoardConnection(orgId, provider);
      connected = Boolean(conn.integrationId);
      enabled = Boolean(conn.enabled);
      if (!connected) detail = "Not connected on the Integrations page.";
      else if (!enabled) detail = "Connected but switched off on the Integrations page.";
      else {
        const caps = await getBoardAdapter(provider).capabilities(conn);
        canPost = caps.posting === true;
        if (!canPost) detail = caps.detail || "This connection cannot post jobs yet.";
      }
    } catch (e) {
      detail = e instanceof Error ? e.message.slice(0, 200) : "Could not check this board.";
    }
    boards.push({ provider, connected, enabled, canPost, detail, live });
  }
  return {
    requisition: { code: r.code, title: r.title, status: r.status },
    applyUrl: applyUrl(r.id),
    careersInbox: inboxAddress(org?.inboxSlug ?? org?.slug ?? null),
    internal: { live: r.ijpEnabled, postedAt: r.ijpPostedAt?.toISOString() ?? null },
    boards,
  };
}

export type RoleTraction = {
  requisition: { code: string; title: string; openings: number; status: string };
  /** Days since it first went live anywhere (internal board or a job board); null = not published. */
  daysLive: number | null;
  applicants: { total: number; last7Days: number; bySource: Record<string, number> };
  scored: number;
  shortlisted: number;
  shortlistTarget: number;
  starving: boolean;
  /** Why it is (or is not) starving, citing the thresholds. */
  verdict: string;
};

export async function roleTraction(orgId: string, requisitionId: string): Promise<RoleTraction> {
  const r = await loadRole(orgId, requisitionId);
  const [first] = (await db.execute(sql`
    select min(t) as at from (
      select ${r.ijpPostedAt?.toISOString() ?? null}::timestamptz as t
      union all
      select published_at from requisition_board_postings
      where requisition_id = ${requisitionId} and org_id = ${orgId} and status = 'published'
    ) x`)) as unknown as { at: string | null }[];
  const liveAt = first?.at ? new Date(first.at) : r.ijpEnabled ? new Date() : null;
  const daysLive = liveAt ? Math.floor((Date.now() - liveAt.getTime()) / 864e5) : null;
  const rows = (await db.execute(sql`
    select a.source,
      count(*)::int total,
      count(*) filter (where a.applied_at >= now() - interval '7 days')::int recent,
      count(m.id)::int scored,
      count(*) filter (where a.stage in ('shortlisted','l1','l2','l3','offer','offer_pending','offer_released','offer_accepted','hired','joined'))::int shortlisted
    from applications a
    left join lateral (select id from match_scores where application_id = a.id limit 1) m on true
    where a.requisition_id = ${requisitionId} and a.org_id = ${orgId}
    group by a.source`)) as unknown as {
    source: string;
    total: number;
    recent: number;
    scored: number;
    shortlisted: number;
  }[];
  const sum = (k: "total" | "recent" | "scored" | "shortlisted") =>
    rows.reduce((n, x) => n + Number(x[k]), 0);
  const external = rows.filter((x) => !(AGENT_SOURCES as readonly string[]).includes(x.source));
  const last7Days = external.reduce((n, x) => n + Number(x.recent), 0);
  const shortlisted = sum("shortlisted");
  const shortlistTarget = Math.max(1, r.openings) * SOURCING.shortlistPerOpening;
  const reasons: string[] = [];
  if (daysLive === null) reasons.push("it is not published anywhere yet");
  else if (daysLive >= SOURCING.minDaysLive && last7Days < SOURCING.minApplicants7d)
    reasons.push(
      `${last7Days} applicant(s) in the last 7 days after ${daysLive} day(s) live (wanted ${SOURCING.minApplicants7d}+)`,
    );
  if (shortlisted < shortlistTarget)
    reasons.push(
      `${shortlisted} shortlisted for ${r.openings} opening(s) (wanted ${shortlistTarget})`,
    );
  const starving = r.status === "approved" && reasons.length > 0;
  return {
    requisition: { code: r.code, title: r.title, openings: r.openings, status: r.status },
    daysLive,
    applicants: {
      total: sum("total"),
      last7Days,
      bySource: Object.fromEntries(rows.map((x) => [x.source, Number(x.total)])),
    },
    scored: sum("scored"),
    shortlisted,
    shortlistTarget,
    starving,
    verdict: starving
      ? `Needs candidates: ${reasons.join("; ")}.`
      : r.status !== "approved"
        ? `The role is ${r.status}; sourcing applies to approved roles only.`
        : `Healthy: ${last7Days} applicant(s) in 7 days, ${shortlisted} shortlisted (target ${shortlistTarget}).`,
  };
}

/** Stages that mean "did well" for another role; hired / joined people are employees now. */
const STRONG_PAST_STAGES = [
  "shortlisted",
  "l1",
  "l2",
  "l3",
  "offer",
  "offer_declined",
  "on_hold",
  "reserve",
  "joining_deferred",
] as const;

export type PastCandidate = {
  candidateId: string;
  name: string;
  experienceYears: number;
  location: string | null;
  pastRole: string;
  pastStage: string;
  lastSeen: string;
  hasEmail: boolean;
  why: string;
  score: number;
};

export async function pastCandidates(
  orgId: string,
  requisitionId: string,
  limit = 10,
): Promise<{ searchedFor: string[]; matches: PastCandidate[] }> {
  const r = await loadRole(orgId, requisitionId);
  const past = (await db.execute(sql`
    select distinct on (c.id)
      c.id candidate_id, c.full_name name, coalesce(c.experience_years, 0)::float experience_years,
      c.location, c.skills, c.resume_text, c.current_employer, (c.email is not null and c.email <> '') has_email,
      rq.title past_role, a.stage past_stage, a.last_activity_at last_seen
    from applications a
    join candidates c on c.id = a.candidate_id
    join requisitions rq on rq.id = a.requisition_id
    where a.org_id = ${orgId} and c.org_id = ${orgId}
      and a.requisition_id <> ${requisitionId}
      and a.stage in (${sql.join(
        STRONG_PAST_STAGES.map((s) => sql`${s}`),
        sql`, `,
      )})
      and c.consent_given
      and not exists (select 1 from applications x where x.candidate_id = c.id and x.requisition_id = ${requisitionId})
      and not exists (
        select 1 from applications h where h.candidate_id = c.id and h.stage in ('hired','joined','offer_accepted')
      )
      and not exists (
        select 1 from email_outbox o where o.org_id = ${orgId} and o.kind = 'role_invite'
          and o.idempotency_key like ${`role_invite:${requisitionId}:`} || c.id::text || ':%'
          and o.created_at >= now() - make_interval(days => ${SOURCING.reinviteDays})
      )
    order by c.id, a.last_activity_at desc
    limit 300`)) as unknown as {
    candidate_id: string;
    name: string;
    experience_years: number;
    location: string | null;
    skills: string[] | null;
    resume_text: string | null;
    current_employer: string | null;
    has_email: boolean;
    past_role: string;
    past_stage: string;
    last_seen: string;
  }[];
  if (!past.length) return { searchedFor: r.mustHave ?? [], matches: [] };
  const { expandSkills, rankPool } = await import("./talent-search.server");
  const groups = await expandSkills(orgId, r.title, r.mustHave ?? []);
  const ranked = rankPool(
    past.map((p) => ({
      candidateId: p.candidate_id,
      name: p.name,
      experienceYears: Number(p.experience_years ?? 0),
      location: p.location,
      skills: p.skills ?? [],
      resumeText: p.resume_text,
      currentEmployer: p.current_employer,
    })),
    groups,
    { experienceMin: r.experienceMin, experienceMax: r.experienceMax, location: r.location },
  ).slice(0, limit);
  const byId = new Map(past.map((p) => [p.candidate_id, p]));
  return {
    searchedFor: groups.map((g) => `${g.skill}: ${g.terms.join(", ")}`),
    matches: ranked.map((m) => {
      const p = byId.get(m.candidateId)!;
      return {
        candidateId: m.candidateId,
        name: m.name,
        experienceYears: m.experienceYears,
        location: m.location,
        pastRole: p.past_role,
        pastStage: p.past_stage,
        lastSeen: new Date(p.last_seen).toISOString().slice(0, 10),
        hasEmail: p.has_email,
        why: `${m.why} · reached ${p.past_stage} for ${p.past_role}`,
        score: m.score,
      };
    }),
  };
}

/** Approved roles with an approved JD that are starving and had no sourcing run recently. */
export async function starvingRoles(
  orgId: string,
): Promise<{ id: string; code: string; title: string; createdBy: string | null }[]> {
  const candidatesRows = await db
    .select({
      id: requisitions.id,
      code: requisitions.code,
      title: requisitions.title,
      createdBy: requisitions.createdBy,
    })
    .from(requisitions)
    .where(
      and(
        eq(requisitions.orgId, orgId),
        eq(requisitions.status, "approved"),
        sql`exists (select 1 from job_descriptions j where j.requisition_id = ${requisitions.id} and j.status = 'approved')`,
        sql`not exists (
          select 1 from agent_runs r where r.org_id = ${orgId} and r.agent_type = 'sourcing'
            and r.subject_id = ${requisitions.id} and r.mode = 'live'
            and (r.status in ('queued','running','awaiting_human') or r.created_at >= now() - make_interval(hours => ${SOURCING.cooldownHours}))
        )`,
      ),
    )
    .limit(10);
  const out: typeof candidatesRows = [];
  for (const r of candidatesRows) {
    if ((await roleTraction(orgId, r.id)).starving) out.push(r);
  }
  return out;
}

/** Candidates may be invited only if they consented, have an email and are not in the pipeline. */
export async function invitable(
  orgId: string,
  requisitionId: string,
  candidateIds: string[],
): Promise<{
  ok: { id: string; name: string; email: string }[];
  skipped: { id: string; reason: string }[];
}> {
  const rows = await db
    .select({
      id: candidates.id,
      name: candidates.fullName,
      email: candidates.email,
      consent: candidates.consentGiven,
    })
    .from(candidates)
    .where(and(eq(candidates.orgId, orgId), inArray(candidates.id, candidateIds)));
  const inPipeline = new Set(
    (
      await db
        .select({ id: applications.candidateId })
        .from(applications)
        .where(
          and(
            eq(applications.orgId, orgId),
            eq(applications.requisitionId, requisitionId),
            inArray(applications.candidateId, candidateIds),
          ),
        )
    ).map((x) => x.id),
  );
  const ok: { id: string; name: string; email: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of candidateIds) {
    const c = rows.find((x) => x.id === id);
    if (!c) skipped.push({ id, reason: "not in this organisation's talent pool" });
    else if (!c.consent) skipped.push({ id, reason: "has not consented to be contacted" });
    else if (!c.email) skipped.push({ id, reason: "has no email address" });
    else if (inPipeline.has(id)) skipped.push({ id, reason: "is already in this role's pipeline" });
    else ok.push({ id, name: c.name, email: c.email });
  }
  return { ok, skipped };
}
