/**
 * The Distribution agent's view of the world (docs/job-distribution-research.md):
 *  - roleChannels: where one approved role is advertised, what each channel
 *    has brought in, which channels have gone quiet, and which channels did
 *    well for this organisation before;
 *  - cvInflow: across the open roles, CVs arriving by channel, portals posted
 *    by hand that have not produced a single CV, careers-inbox mail that
 *    could not be read, and portal CVs filed against no role;
 *  - restrictedPastRetention / eraseRestricted: CVs a portal limited to their
 *    role (candidates.pool_use = 'role_only') once that role is over — erased
 *    only after a person approves.
 *
 * Read paths only ever return what a person in the organisation may see;
 * the one destructive path re-checks eligibility before erasing.
 */
import { sql } from "drizzle-orm";

import { db } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { JOB_CHANNELS, channelById, sourceLabel } from "@/lib/job-channels";

export const DISTRIBUTION = {
  /** A channel live this many days with no CV from it counts as quiet. */
  quietDays: 7,
  /** …and is a health finding after this many. */
  quietHealthDays: 14,
  /** Role-limited CVs are kept this many days after their role is over, then erasure is proposed. */
  retentionGraceDays: 30,
  /** At most this many CVs per erasure request. */
  eraseBatch: 25,
} as const;

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];
const site = () => env.PUBLIC_SITE_URL.replace(/\/$/, "");
const TERMINAL = ["rejected", "withdrawn", "offer_declined", "no_show"];
const HIRED = ["offer_accepted", "hired", "joined"];
const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

/* ------------------------------------------------------------ one role */

export async function roleChannels(orgId: string, requisitionId: string) {
  const { distributionStatus, channelReport } = await import("../distribution/distribution.server");
  const [req] = await rows<{ code: string; title: string; status: string }>(sql`
    select code, title, status::text status from requisitions
    where id = ${requisitionId} and org_id = ${orgId}`);
  if (!req) throw new Error("Requisition not found.");
  const status = await distributionStatus(orgId, requisitionId);
  const inflow = await rows<{
    source: string;
    total: number;
    last7d: number;
    first_at: string;
  }>(sql`
    select source, count(*)::int total,
      count(*) filter (where applied_at >= now() - interval '7 days')::int last7d,
      min(applied_at)::text first_at
    from applications where org_id = ${orgId} and requisition_id = ${requisitionId}
    group by source order by count(*) desc`);
  const bySource = new Map(inflow.map((r) => [r.source, r]));
  const now = Date.now();
  const live = status.postings.filter((p) => p.status === "published");
  const quiet = live
    .map((p) => ({
      channel: p.provider,
      name: sourceLabel(p.provider),
      liveDays: p.publishedAt ? Math.floor((now - Date.parse(p.publishedAt)) / 864e5) : 0,
      cvs: bySource.get(p.provider)?.total ?? 0,
    }))
    .filter((p) => p.cvs === 0 && p.liveDays >= DISTRIBUTION.quietDays);
  const history = (await channelReport(orgId, 365))
    .filter((r) => channelById(r.source) && r.applicants > 0)
    .slice(0, 8)
    .map((r) => ({
      channel: r.source,
      name: sourceLabel(r.source),
      applicants: r.applicants,
      shortlisted: r.shortlisted,
      hired: r.hired,
    }));
  return {
    requisition: {
      code: req.code,
      title: req.title,
      status: req.status,
      forClient: status.forClient,
    },
    requisitionPage: `${site()}/requisitions/${requisitionId}`,
    google: {
      switchedOnForOrganisation: status.google.orgEnabled,
      listed: status.google.listed,
      excluded: status.google.excluded,
      gaps: status.google.gaps,
    },
    feedLinksCreated: status.feedReady,
    channels: JOB_CHANNELS.filter((c) => c.route !== "structured_data").map((c) => {
      const p = status.postings.find((x) => x.provider === c.id);
      const isLive = p?.status === "published";
      return {
        channel: c.id,
        name: c.name,
        route: c.route,
        region: c.region,
        live: isLive,
        since: isLive ? (p?.publishedAt ?? null) : null,
        viaIntegration: Boolean(p?.viaIntegration),
        cvs: bySource.get(c.id)?.total ?? 0,
        cvsLast7d: bySource.get(c.id)?.last7d ?? 0,
        dataUse: c.dataUse,
      };
    }),
    otherSources: inflow
      .filter((r) => !channelById(r.source))
      .map((r) => ({ source: sourceLabel(r.source), cvs: r.total, cvsLast7d: r.last7d })),
    quiet,
    history,
  };
}

/* ------------------------------------------------------- across roles */

export async function cvInflow(orgId: string) {
  const portalIds = JOB_CHANNELS.map((c) => c.id);
  const arrived = await rows<{ source: string; n: number }>(sql`
    select a.source, count(*)::int n from applications a
    where a.org_id = ${orgId} and a.applied_at >= now() - interval '7 days'
    group by a.source order by count(*) desc`);
  const quiet = await rows<{
    requisition_id: string;
    code: string;
    title: string;
    provider: string;
    live_days: number;
  }>(sql`
    select r.id requisition_id, r.code, r.title, p.provider,
      floor(extract(epoch from now() - p.published_at) / 86400)::int live_days
    from requisition_board_postings p
    join requisitions r on r.id = p.requisition_id and r.org_id = p.org_id
    where p.org_id = ${orgId} and p.status = 'published' and r.status = 'approved'
      and p.provider in (${list(portalIds)})
      -- Google lists roles on its own; nobody posted it, so nobody chases it.
      and p.provider <> 'google_jobs'
      and p.published_at <= now() - make_interval(days => ${DISTRIBUTION.quietDays})
      and not exists (
        select 1 from applications a
        where a.requisition_id = r.id and a.source = p.provider)
    order by p.published_at
    limit 50`);
  const [inbox] = await rows<{ unread: number }>(sql`
    select count(*)::int unread from inbox_messages
    where org_id = ${orgId} and status = 'error' and received_at >= now() - interval '7 days'`);
  const [unfiled] = await rows<{ n: number }>(sql`
    select count(*)::int n from candidates c
    where c.org_id = ${orgId} and c.source in (${list(portalIds)})
      and c.created_at >= now() - interval '14 days'
      and not exists (select 1 from applications a where a.candidate_id = c.id)`);
  return {
    last7Days: arrived.map((r) => ({ source: sourceLabel(r.source), cvs: r.n })),
    quietListings: quiet.map((q) => ({
      requisitionId: q.requisition_id,
      requisition: `${q.code} "${q.title}"`,
      channel: q.provider,
      name: sourceLabel(q.provider),
      liveDays: q.live_days,
      howCvsComeBack: channelById(q.provider)?.applications ?? "",
      requisitionPage: `${site()}/requisitions/${q.requisition_id}`,
    })),
    inboxMailNotRead7d: inbox?.unread ?? 0,
    portalCvsWithNoRole14d: unfiled?.n ?? 0,
    careersInboxPage: `${site()}/inbox`,
  };
}

/* ------------------------------------------------- role-limited CVs */

/** The role-limited CVs whose roles are over (ids, oldest first). */
async function eligibleRestricted(
  orgId: string,
  ids?: string[],
  graceDays: number = DISTRIBUTION.retentionGraceDays,
) {
  return rows<{ id: string; name: string; source: string | null; last_activity: string }>(sql`
    select c.id, c.full_name name, c.pool_use_source source,
      coalesce(max(a.last_activity_at), c.created_at)::text last_activity
    from candidates c
    left join applications a on a.candidate_id = c.id
    where c.org_id = ${orgId} and c.pool_use = 'role_only'
      ${ids?.length ? sql`and c.id in (${list(ids)})` : sql``}
      and not exists (
        select 1 from applications h where h.candidate_id = c.id and h.stage::text in (${list(HIRED)}))
      and not exists (
        select 1 from applications o join requisitions r on r.id = o.requisition_id
        where o.candidate_id = c.id
          and r.status::text not in ('closed', 'rejected')
          and o.stage::text not in (${list(TERMINAL)}))
    group by c.id
    having coalesce(max(a.last_activity_at), c.created_at)
      < now() - make_interval(days => ${graceDays})
    order by 4
    limit 200`);
}

export async function restrictedPastRetention(orgId: string) {
  const r = await eligibleRestricted(orgId);
  return {
    count: r.length,
    rule: `CVs a portal limited to their role are kept ${DISTRIBUTION.retentionGraceDays} days after that role is over (closed, or the person was turned down or withdrew), then erased once a person approves.`,
    candidates: r.slice(0, DISTRIBUTION.eraseBatch).map((x) => ({
      candidateId: x.id,
      name: x.name,
      portal: x.source ? sourceLabel(x.source) : "a portal",
      why: channelById(x.source)?.dataUseNote ?? "The portal's terms limit the CV to its role.",
      lastActivity: x.last_activity.slice(0, 10),
    })),
  };
}

/** Role-limited CVs still kept `overdueDays` after they became due for erasure. */
export async function overdueRestricted(orgId: string, overdueDays: number): Promise<number> {
  return (await eligibleRestricted(orgId, undefined, DISTRIBUTION.retentionGraceDays + overdueDays))
    .length;
}

/**
 * Erase the given role-limited CVs that are still past retention (anyone
 * hired, back in an open role or never role-limited is skipped). Audited.
 */
export async function eraseRestricted(
  orgId: string,
  actor: { memberEmail: string; userId: string; label: string },
  candidateIds: string[],
): Promise<{ erased: string[]; skipped: number }> {
  const ids = [...new Set(candidateIds)].slice(0, DISTRIBUTION.eraseBatch);
  const eligible = await eligibleRestricted(orgId, ids);
  const { eraseCandidatesCore } = await import("../erase.server");
  const erased = await eraseCandidatesCore(
    orgId,
    eligible.map((e) => e.id),
  );
  await writeAudit({
    actor: actor.label,
    orgId,
    actorUserId: actor.userId,
    action: "candidate.erase_role_limited",
    entityType: "candidate",
    detail: {
      approvedBy: actor.memberEmail,
      erased: erased.length,
      skipped: ids.length - erased.length,
      sources: [...new Set(eligible.map((e) => e.source))],
    },
  });
  return { erased: erased.map((e) => e.fullName), skipped: ids.length - erased.length };
}
