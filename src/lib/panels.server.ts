/**
 * Interview panels per role and round (docs/interview-panel-plan.md, P2;
 * docs/panel-directory.md).
 *
 * People come from the panel directory (`panelists`): internal panelists (org
 * members, kept in step by syncMemberPanelists) and external ones added in the
 * hiring desk. `memberId` throughout this file is the panelist's directory id.
 *
 * - Who is eligible for a round: active panelists who take that round, under
 *   their weekly cap — for org members, their interviewer profile when the
 *   organisation has registered interviewers — ranked by how many of the
 *   round's competencies their areas cover, then rounds they took for the role,
 *   then the lightest load. An organisation that has registered no
 *   interviewers yet falls back to every active member (said so on the card).
 * - The approved panel: proposed by the Interview coordinator, approved (or
 *   changed) by a person, reused for every candidate of the role and round.
 * Every query is scoped to the organisation.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  applications,
  interviews,
  orgMembers,
  panelists,
  requisitions,
  rolePanels,
  roundSubstitutes,
} from "@db/schema";
import { db } from "../server/db";

export type EligibleInterviewer = {
  /** The panel directory id (panelists.id). */
  memberId: string;
  name: string;
  email: string;
  kind: "internal" | "external";
  /** External panelists: their organisation. */
  company: string | null;
  /** The round's competencies their areas cover. */
  covers: string[];
  /** Rounds they already interviewed for this role. */
  pastRounds: number;
  /** Interviews booked for them in the next 7 days, and their weekly cap. */
  load: number;
  cap: number | null;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The competencies an interviewer's areas cover: either contains the other (pure). */
export function coverage(areas: string[], competencies: string[]): string[] {
  const a = areas.map(norm).filter(Boolean);
  return competencies.filter((c) => {
    const n = norm(c);
    return a.some((x) => x === n || x.includes(n) || n.includes(x));
  });
}

/** Best first: competencies covered, then rounds taken for the role, then the lightest load (pure). */
export function rankInterviewers<T extends EligibleInterviewer>(people: T[]): T[] {
  return [...people].sort(
    (x, y) =>
      y.covers.length - x.covers.length ||
      y.pastRounds - x.pastRounds ||
      x.load - y.load ||
      x.name.localeCompare(y.name),
  );
}

/**
 * Who may sit on round `level` of a role, ranked. `registered` is false when
 * the organisation has no interviewer profiles yet (everyone active is listed).
 * `full` lists registered interviewers left out because they reached their cap.
 */
export async function eligibleInterviewers(
  orgId: string,
  requisitionId: string,
  level: number,
): Promise<{ registered: boolean; people: EligibleInterviewer[]; full: string[] }> {
  const { planFor } = await import("./interview-plan.server");
  const { roundOf } = await import("./interview-plan");
  const round = roundOf((await planFor(orgId, requisitionId)).plan, level);
  if (!round) throw new Error(`This role's interview plan has no round L${level}.`);
  await syncMemberPanelists(orgId);
  const rows = (await db.execute(sql`
    select p.id, p.kind, p.company, p.full_name as name,
      coalesce(m.email, p.email) as email,
      p.member_id, prof.active as profile_active,
      coalesce(prof.areas, p.areas) as areas,
      coalesce(prof.rounds, p.rounds) as rounds,
      coalesce(prof.weekly_cap, p.weekly_cap) as weekly_cap,
      (select count(*)::int from interviews i join applications a on a.id = i.application_id
        where i.org_id = ${orgId} and a.requisition_id = ${requisitionId}
          and (lower(i.interviewer_email) = lower(coalesce(m.email, p.email))
            or i.panel @> jsonb_build_array(jsonb_build_object('email', lower(coalesce(m.email, p.email)))))) as past_rounds,
      (select count(*)::int from interviews i
        where i.org_id = ${orgId} and i.status not in ('cancelled', 'no_show')
          and i.scheduled_at >= now() and i.scheduled_at < now() + interval '7 days'
          and (lower(i.interviewer_email) = lower(coalesce(m.email, p.email))
            or i.panel @> jsonb_build_array(jsonb_build_object('email', lower(coalesce(m.email, p.email)))))) as load
    from panelists p
    left join org_members m on m.id = p.member_id and m.org_id = p.org_id
    left join member_interviewer_profiles prof on prof.member_id = p.member_id and prof.org_id = p.org_id
    where p.org_id = ${orgId} and p.active
      and (p.member_id is null or m.status = 'active')`)) as unknown as {
    id: string;
    kind: "internal" | "external";
    company: string | null;
    name: string;
    email: string;
    member_id: string | null;
    profile_active: boolean | null;
    areas: string[] | null;
    rounds: number[] | null;
    weekly_cap: number | null;
    past_rounds: number;
    load: number;
  }[];
  // "Registered": the organisation set up interviewer profiles for its members;
  // members without one are then left out. Directory-only panelists (external,
  // or internal without a login) are always in, by their own rounds and cap.
  const registered = rows.some((r) => r.member_id && r.profile_active);
  const full: string[] = [];
  const people: EligibleInterviewer[] = [];
  for (const r of rows) {
    const member = Boolean(r.member_id);
    const gated = !member || registered;
    if (member && registered && !r.profile_active) continue;
    if (gated) {
      if (!(r.rounds ?? []).includes(level)) continue;
      if (r.weekly_cap !== null && r.load >= r.weekly_cap) {
        full.push(r.name);
        continue;
      }
    }
    people.push({
      memberId: r.id,
      name: r.name,
      email: r.email.toLowerCase(),
      kind: r.kind,
      company: r.company,
      covers: coverage(r.areas ?? [], round.competencies),
      pastRounds: r.past_rounds,
      load: r.load,
      cap: gated ? r.weekly_cap : null,
    });
  }
  return { registered, people: rankInterviewers(people), full };
}

export type PanelPerson = {
  /** The panel directory id (panelists.id). */
  memberId: string;
  name: string;
  email: string;
  kind: "internal" | "external";
};

export type ApprovedPanel = {
  level: number;
  version: number;
  members: PanelPerson[];
};

/**
 * Directory ids for these ids, in order: a panel directory id stays as it is,
 * an org member's id becomes their internal entry (panels and stand-ins stored
 * before the directory, and callers that still pass member ids). Unknown ids
 * are kept, so validation refuses them.
 */
export async function toPanelistIds(orgId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const find = () =>
    db
      .select({ id: panelists.id, memberId: panelists.memberId })
      .from(panelists)
      .where(
        and(
          eq(panelists.orgId, orgId),
          sql`(${panelists.id} = any(${sql.param(ids)}::uuid[]) or ${panelists.memberId} = any(${sql.param(ids)}::uuid[]))`,
        ),
      );
  let rows = await find();
  const missing = ids.some((id) => !rows.some((r) => r.id === id || r.memberId === id));
  if (missing) {
    await syncMemberPanelists(orgId);
    rows = await find();
  }
  return ids.map((id) => rows.find((r) => r.id === id || r.memberId === id)?.id ?? id);
}

/**
 * Directory entries for these ids that may sit on a panel now: active, and —
 * for org members — still active members. In the order asked; others drop out.
 */
export async function panelPeople(orgId: string, given: string[]): Promise<PanelPerson[]> {
  if (!given.length) return [];
  const ids = await toPanelistIds(orgId, given);
  const rows = await db
    .select({
      memberId: panelists.id,
      name: panelists.fullName,
      email: sql<string>`lower(coalesce(${orgMembers.email}, ${panelists.email}))`,
      kind: panelists.kind,
      linked: panelists.memberId,
      memberStatus: orgMembers.status,
    })
    .from(panelists)
    .leftJoin(
      orgMembers,
      and(eq(orgMembers.id, panelists.memberId), eq(orgMembers.orgId, panelists.orgId)),
    )
    .where(and(eq(panelists.orgId, orgId), eq(panelists.active, true), inArray(panelists.id, ids)));
  const ok = rows.filter((r) => !r.linked || r.memberStatus === "active");
  return ids
    .map((id) => ok.find((r) => r.memberId === id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map(({ memberId, name, email, kind }) => ({ memberId, name, email, kind }));
}

/**
 * Keep every org member in the directory as an internal panelist (members who
 * joined after migration 0068), and their name and e-mail current.
 */
export async function syncMemberPanelists(orgId: string): Promise<void> {
  await db.execute(sql`
    insert into panelists (org_id, kind, member_id, full_name, email, approved_at)
    select m.org_id, 'internal', m.id, coalesce(nullif(m.full_name, ''), m.email), lower(m.email), now()
    from org_members m
    where m.org_id = ${orgId}
      and not exists (select 1 from panelists p where p.member_id = m.id)
    on conflict do nothing`);
  await db.execute(sql`
    update panelists p
    set full_name = coalesce(nullif(m.full_name, ''), m.email), email = lower(m.email), updated_at = now()
    from org_members m
    where p.member_id = m.id and p.org_id = ${orgId}
      and (p.full_name is distinct from coalesce(nullif(m.full_name, ''), m.email)
        or p.email is distinct from lower(m.email))`);
}

/** The approved panel for a role and round, with its members as they are now (null: none yet). */
export async function approvedPanel(
  orgId: string,
  requisitionId: string,
  level: number,
): Promise<ApprovedPanel | null> {
  const [p] = await db
    .select({
      ids: rolePanels.panelistIds,
      memberIds: rolePanels.memberIds,
      version: rolePanels.version,
    })
    .from(rolePanels)
    .where(
      and(
        eq(rolePanels.orgId, orgId),
        eq(rolePanels.requisitionId, requisitionId),
        eq(rolePanels.level, level),
      ),
    )
    .limit(1);
  // Panels approved before the directory stored org-member ids.
  const ids = p?.ids?.length ? p.ids : (p?.memberIds ?? []);
  if (!p || !ids.length) return null;
  // In the approved order; anyone no longer active drops out.
  const members = await panelPeople(orgId, ids);
  return members.length ? { level, version: p.version, members } : null;
}

/**
 * Store an approved panel (a person's decision; the caller checked who may
 * make it). Everyone must be an active entry of the panel directory. Audited.
 */
export async function savePanel(
  orgId: string,
  approverUserId: string,
  requisitionId: string,
  level: number,
  memberIds: string[],
  changed: boolean,
): Promise<ApprovedPanel> {
  const ids = [...new Set(await toPanelistIds(orgId, memberIds))];
  if (ids.length < 1 || ids.length > 3) throw new Error("A panel has one to three people.");
  const [req] = await db
    .select({ code: requisitions.code })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  const people = await panelPeople(orgId, ids);
  if (people.length !== ids.length)
    throw new Error("Everyone on a panel must be an active entry of your panel directory.");
  // Org members on the panel, for code that still reads member_ids.
  const linked = await db
    .select({ memberId: panelists.memberId })
    .from(panelists)
    .where(and(eq(panelists.orgId, orgId), inArray(panelists.id, ids)));
  const linkedMembers = linked.map((r) => r.memberId).filter((x): x is string => Boolean(x));
  const now = new Date();
  await db
    .insert(rolePanels)
    .values({
      orgId,
      requisitionId,
      level,
      memberIds: linkedMembers,
      panelistIds: ids,
      approvedBy: approverUserId,
      approvedAt: now,
    })
    .onConflictDoUpdate({
      target: [rolePanels.requisitionId, rolePanels.level],
      set: {
        memberIds: linkedMembers,
        panelistIds: ids,
        approvedBy: approverUserId,
        approvedAt: now,
        version: sql`${rolePanels.version} + 1`,
      },
    });
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${approverUserId}`,
    actorUserId: approverUserId,
    orgId,
    action: "role_panel.approved",
    entityType: "requisition",
    entityId: requisitionId,
    detail: {
      code: req.code,
      level,
      members: people.map((p) => p.email),
      external: people.filter((p) => p.kind === "external").map((p) => p.email),
      changed,
    },
  });
  return (await approvedPanel(orgId, requisitionId, level))!;
}

/**
 * The panel for one candidate's round: the role's approved panel with any
 * approved substitutes for that candidate applied, in order. Null: no
 * approved panel for the round yet.
 */
export async function roundPanel(
  orgId: string,
  applicationId: string,
  level: number,
): Promise<(ApprovedPanel & { substituted: { replaced: string; with: string }[] }) | null> {
  const [app] = await db
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  if (!app) throw new Error("Application not found.");
  const panel = await approvedPanel(orgId, app.requisitionId, level);
  if (!panel) return null;
  const subs = await db
    .select({
      replace: sql<string>`coalesce(${roundSubstitutes.replacePanelistId}, ${roundSubstitutes.replaceMemberId})`,
      with: sql<string>`coalesce(${roundSubstitutes.withPanelistId}, ${roundSubstitutes.withMemberId})`,
    })
    .from(roundSubstitutes)
    .where(
      and(
        eq(roundSubstitutes.orgId, orgId),
        eq(roundSubstitutes.applicationId, applicationId),
        eq(roundSubstitutes.level, level),
      ),
    );
  if (!subs.length) return { ...panel, substituted: [] };
  // Stand-ins stored before the directory hold org-member ids.
  const replaced = await toPanelistIds(
    orgId,
    subs.map((x) => x.replace),
  );
  const withIds = await toPanelistIds(
    orgId,
    subs.map((x) => x.with),
  );
  subs.forEach((x, i) => {
    x.replace = replaced[i]!;
    x.with = withIds[i]!;
  });
  const people = await panelPeople(orgId, withIds);
  const substituted: { replaced: string; with: string }[] = [];
  const members = panel.members.map((m) => {
    const sub = subs.find((x) => x.replace === m.memberId);
    const p = sub ? people.find((x) => x.memberId === sub.with) : undefined;
    if (!p) return m;
    substituted.push({ replaced: m.name, with: p.name });
    return p;
  });
  return { ...panel, members, substituted };
}

/**
 * Whether interviewers offered or booked for a candidate's round are its panel
 * (the approved one, with that candidate's approved substitutes) — a reason
 * to refuse, or null. Agents only offer times to that panel.
 */
export async function panelMismatch(
  orgId: string,
  applicationId: string,
  level: number,
  emails: string[],
): Promise<string | null> {
  const panel = await roundPanel(orgId, applicationId, level);
  if (!panel)
    return `Round L${level} of this role has no approved panel yet. Call propose_panel for it and wait for the person's decision before finding or offering times.`;
  const want = panel.members.map((m) => m.email.toLowerCase()).sort();
  const got = [...new Set(emails.map((e) => e.toLowerCase()))].sort();
  if (want.join(",") !== got.join(","))
    return `Use this candidate's L${level} panel — exactly ${panel.members.map((m) => `${m.name} (${m.email})`).join(", ")}: the first as interviewerEmail, the rest as panelEmails.`;
  return null;
}

/**
 * Who could stand in for `replaceMemberId` on one candidate's round: eligible
 * for the round, not already on it, best first. When the round is booked,
 * `freeAtBookedTime` says whether they are free then (calendar + bookings).
 */
export async function substituteOptions(
  orgId: string,
  applicationId: string,
  level: number,
  replaceMemberId: string,
): Promise<{
  bookedAt: string | null;
  options: (EligibleInterviewer & { freeAtBookedTime: boolean | null })[];
}> {
  const panel = await roundPanel(orgId, applicationId, level);
  if (!panel) throw new Error(`Round L${level} has no approved panel yet.`);
  replaceMemberId = (await toPanelistIds(orgId, [replaceMemberId]))[0] ?? replaceMemberId;
  if (!panel.members.some((m) => m.memberId === replaceMemberId))
    throw new Error("That person is not on this candidate's panel for the round.");
  const [app] = await db
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.orgId, orgId)))
    .limit(1);
  const { people } = await eligibleInterviewers(orgId, app!.requisitionId, level);
  const booked = await bookedRound(orgId, applicationId, level);
  const { isFree } = await import("./calendar-availability.server");
  const options = [];
  for (const p of people) {
    if (panel.members.some((m) => m.memberId === p.memberId)) continue;
    const freeAtBookedTime = booked?.scheduledAt
      ? (await isFree(orgId, p.email, booked.scheduledAt.toISOString(), booked.durationMins)).free
      : null;
    options.push({ ...p, freeAtBookedTime });
  }
  // Free at the booked time first (no change for the candidate), then the ranking.
  options.sort((a, b) => Number(b.freeAtBookedTime === true) - Number(a.freeAtBookedTime === true));
  return { bookedAt: booked?.scheduledAt?.toISOString() ?? null, options };
}

/** The candidate's booked, not-yet-held interview for a round (or null). */
export async function bookedRound(orgId: string, applicationId: string, level: number) {
  const [r] = await db
    .select()
    .from(interviews)
    .where(
      and(
        eq(interviews.orgId, orgId),
        eq(interviews.applicationId, applicationId),
        eq(interviews.level, level),
        inArray(interviews.status, ["scheduled", "rescheduled"]),
        sql`${interviews.scheduledAt} > now()`,
      ),
    )
    .limit(1);
  return r ?? null;
}
