/**
 * Interview panels per role and round (docs/interview-panel-plan.md, P2).
 *
 * - Who is eligible for a round: active members whose interviewer profile is on
 *   and takes that round, under their weekly cap — ranked by how many of the
 *   round's competencies their areas cover, then rounds they took for the role,
 *   then the lightest load. An organisation that has registered no
 *   interviewers yet falls back to every active member (said so on the card).
 * - The approved panel: proposed by the Interview coordinator, approved (or
 *   changed) by a person, reused for every candidate of the role and round.
 * Every query is scoped to the organisation.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { orgMembers, requisitions, rolePanels } from "@db/schema";
import { db } from "../server/db";

export type EligibleInterviewer = {
  memberId: string;
  name: string;
  email: string;
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
  const rows = (await db.execute(sql`
    select m.id, coalesce(nullif(m.full_name, ''), m.email) as name, m.email,
      p.active as profile_active, p.areas, p.rounds, p.weekly_cap,
      (select count(*)::int from interviews i join applications a on a.id = i.application_id
        where i.org_id = ${orgId} and a.requisition_id = ${requisitionId}
          and (lower(i.interviewer_email) = lower(m.email)
            or i.panel @> jsonb_build_array(jsonb_build_object('email', m.email)))) as past_rounds,
      (select count(*)::int from interviews i
        where i.org_id = ${orgId} and i.status not in ('cancelled', 'no_show')
          and i.scheduled_at >= now() and i.scheduled_at < now() + interval '7 days'
          and (lower(i.interviewer_email) = lower(m.email)
            or i.panel @> jsonb_build_array(jsonb_build_object('email', m.email)))) as load
    from org_members m
    left join member_interviewer_profiles p on p.member_id = m.id and p.org_id = m.org_id
    where m.org_id = ${orgId} and m.status = 'active'`)) as unknown as {
    id: string;
    name: string;
    email: string;
    profile_active: boolean | null;
    areas: string[] | null;
    rounds: number[] | null;
    weekly_cap: number | null;
    past_rounds: number;
    load: number;
  }[];
  const registered = rows.some((r) => r.profile_active);
  const full: string[] = [];
  const people: EligibleInterviewer[] = [];
  for (const r of rows) {
    if (registered) {
      if (!r.profile_active || !(r.rounds ?? []).includes(level)) continue;
      if (r.weekly_cap !== null && r.load >= r.weekly_cap) {
        full.push(r.name);
        continue;
      }
    }
    people.push({
      memberId: r.id,
      name: r.name,
      email: r.email,
      covers: coverage(r.areas ?? [], round.competencies),
      pastRounds: r.past_rounds,
      load: r.load,
      cap: registered ? r.weekly_cap : null,
    });
  }
  return { registered, people: rankInterviewers(people), full };
}

export type ApprovedPanel = {
  level: number;
  version: number;
  members: { memberId: string; name: string; email: string }[];
};

/** The approved panel for a role and round, with its members as they are now (null: none yet). */
export async function approvedPanel(
  orgId: string,
  requisitionId: string,
  level: number,
): Promise<ApprovedPanel | null> {
  const [p] = await db
    .select({ memberIds: rolePanels.memberIds, version: rolePanels.version })
    .from(rolePanels)
    .where(
      and(
        eq(rolePanels.orgId, orgId),
        eq(rolePanels.requisitionId, requisitionId),
        eq(rolePanels.level, level),
      ),
    )
    .limit(1);
  if (!p) return null;
  const people = await db
    .select({
      memberId: orgMembers.id,
      name: sql<string>`coalesce(nullif(${orgMembers.fullName}, ''), ${orgMembers.email})`,
      email: orgMembers.email,
    })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        inArray(orgMembers.id, p.memberIds),
      ),
    );
  // In the approved order; anyone no longer active drops out.
  const members = p.memberIds
    .map((id) => people.find((m) => m.memberId === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  return members.length ? { level, version: p.version, members } : null;
}

/**
 * Store an approved panel (a person's decision; the caller checked who may
 * make it). Members must be active members of the organisation. Audited.
 */
export async function savePanel(
  orgId: string,
  approverUserId: string,
  requisitionId: string,
  level: number,
  memberIds: string[],
  changed: boolean,
): Promise<ApprovedPanel> {
  const ids = [...new Set(memberIds)];
  if (ids.length < 1 || ids.length > 3) throw new Error("A panel has one to three people.");
  const [req] = await db
    .select({ code: requisitions.code })
    .from(requisitions)
    .where(and(eq(requisitions.id, requisitionId), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!req) throw new Error("Requisition not found.");
  const people = await db
    .select({ id: orgMembers.id, email: orgMembers.email })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, "active"),
        inArray(orgMembers.id, ids),
      ),
    );
  if (people.length !== ids.length)
    throw new Error("Everyone on a panel must be an active member of your organisation.");
  const now = new Date();
  await db
    .insert(rolePanels)
    .values({
      orgId,
      requisitionId,
      level,
      memberIds: ids,
      approvedBy: approverUserId,
      approvedAt: now,
    })
    .onConflictDoUpdate({
      target: [rolePanels.requisitionId, rolePanels.level],
      set: {
        memberIds: ids,
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
      members: ids.map((id) => people.find((p) => p.id === id)!.email),
      changed,
    },
  });
  return (await approvedPanel(orgId, requisitionId, level))!;
}

/**
 * Whether interviewers offered or booked for a round are its approved panel
 * (a reason to refuse, or null). Agents only offer times to an approved panel.
 */
export async function panelMismatch(
  orgId: string,
  requisitionId: string,
  level: number,
  emails: string[],
): Promise<string | null> {
  const panel = await approvedPanel(orgId, requisitionId, level);
  if (!panel)
    return `Round L${level} of this role has no approved panel yet. Call propose_panel for it and wait for the person's decision before finding or offering times.`;
  const want = panel.members.map((m) => m.email.toLowerCase()).sort();
  const got = [...new Set(emails.map((e) => e.toLowerCase()))].sort();
  if (want.join(",") !== got.join(","))
    return `Use the approved L${level} panel — exactly ${panel.members.map((m) => `${m.name} (${m.email})`).join(", ")}: the first as interviewerEmail, the rest as panelEmails.`;
  return null;
}
