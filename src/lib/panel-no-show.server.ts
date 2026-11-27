/**
 * A panel no-show: a booked round reached its start time and a panellist did
 * not join without having said beforehand that they could not make it. The
 * candidate must not lose the round over it, so each one who missed is warned,
 * the HR heads are told at once (an escalation, not a courtesy), every miss is
 * audited so repeats are visible, and the Interview coordinator is asked for a
 * stand-in for each of them before new times are offered.
 */
import { and, eq, sql } from "drizzle-orm";

import { interviews, requisitions } from "@db/schema";
import { db } from "../server/db";
import { env } from "../server/env";

/** How far back earlier no-shows of the same panellist are counted. */
export const PANEL_NO_SHOW_WINDOW_DAYS = 90;

export type PanelNoShow = { email: string; memberId: string | null; name: string };

/**
 * Who on the round missed it without notice (pure). When the person marking
 * it named who did not join, those of them on the round; otherwise everyone on
 * the round less the person marking it (they were there to mark it). Anyone
 * who said beforehand they could not make it gave notice and is left out.
 * Empty when the round had not started — a change before the start is notice.
 */
export function noShowEmails(
  r: {
    scheduledAt: Date | null;
    lead: string | null;
    panel: { email: string }[] | null;
    unavailable: { email: string }[] | null;
  },
  markedBy: string,
  now = Date.now(),
  named?: string[],
): string[] {
  if (!r.scheduledAt || r.scheduledAt.getTime() > now) return [];
  const norm = (e: string | null | undefined) => e?.trim().toLowerCase() ?? "";
  const gaveNotice = new Set((r.unavailable ?? []).map((u) => norm(u.email)));
  const me = norm(markedBy);
  const people = [...new Set([r.lead, ...(r.panel ?? []).map((p) => p.email)].map(norm))];
  const picked = named ? new Set(named.map(norm)) : null;
  return people.filter((e) => e && !gaveNotice.has(e) && (picked ? picked.has(e) : e !== me));
}

/**
 * Warn, escalate and record. Returns who missed (with their panel ids for a
 * stand-in) so the Interview coordinator can be told. Never throws past the
 * record: a failed e-mail must not stop the round being re-arranged.
 */
export async function handlePanelNoShow(
  orgId: string,
  r: {
    id: string;
    level: number;
    applicationId: string;
    requisitionId: string;
    candidateName: string | null;
  },
  markedBy: string,
  actor: { email: string; userId: string | null },
  named?: string[],
): Promise<PanelNoShow[]> {
  const [iv] = await db
    .select({
      scheduledAt: interviews.scheduledAt,
      lead: interviews.interviewerEmail,
      leadName: interviews.interviewer,
      panel: interviews.panel,
      unavailable: interviews.unavailable,
      jobTitle: requisitions.title,
      jobCode: requisitions.code,
    })
    .from(interviews)
    .innerJoin(requisitions, eq(requisitions.id, r.requisitionId))
    .where(and(eq(interviews.orgId, orgId), eq(interviews.id, r.id)))
    .limit(1);
  if (!iv) return [];
  const emails = noShowEmails(iv, markedBy, Date.now(), named);
  if (!emails.length) return [];

  const nameOf = (e: string) =>
    (iv.lead?.toLowerCase() === e ? iv.leadName : null) ??
    iv.panel?.find((p) => p.email.toLowerCase() === e)?.name ??
    e;
  const { roundPanel } = await import("./panels.server");
  const panel = await roundPanel(orgId, r.applicationId, r.level).catch(() => null);
  const missed: PanelNoShow[] = emails.map((email) => ({
    email,
    name: nameOf(email),
    memberId: panel?.members.find((m) => m.email.toLowerCase() === email)?.memberId ?? null,
  }));

  const { writeAudit } = await import("../server/audit");
  const earlier = new Map<string, number>();
  for (const m of missed) {
    const [c] = (await db.execute(sql`
      select count(*)::int n from audit_log
       where org_id = ${orgId} and action = 'interview.panel_no_show'
         and lower(detail ->> 'email') = ${m.email}
         and created_at >= now() - make_interval(days => ${PANEL_NO_SHOW_WINDOW_DAYS})`)) as unknown as {
      n: number;
    }[];
    earlier.set(m.email, c?.n ?? 0);
    await writeAudit({
      actor: actor.email,
      actorUserId: actor.userId,
      orgId,
      action: "interview.panel_no_show",
      entityType: "interview",
      entityId: r.id,
      detail: { email: m.email, level: r.level, applicationId: r.applicationId },
    });
  }

  const { enqueueEmail, formatInOrgTZ, getOrgEmailSettings } =
    await import("./email-outbox.server");
  const when = iv.scheduledAt
    ? formatInOrgTZ(iv.scheduledAt, (await getOrgEmailSettings(orgId)).timezone)
    : "its booked time";
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
  const who = r.candidateName ?? "The candidate";
  const role = `${iv.jobTitle ?? "the role"}${iv.jobCode ? ` (${iv.jobCode})` : ""}`;
  const times = (n: number) => (n === 1 ? "once before" : `${n} times before`);

  for (const m of missed) {
    const n = earlier.get(m.email) ?? 0;
    try {
      await enqueueEmail({
        orgId,
        kind: "member_reminder",
        templateName: "member_reminder",
        toEmail: m.email,
        applicationId: r.applicationId,
        idempotencyKey: `panel-no-show-warning:${r.id}:${m.email}`,
        templateData: {
          heading: `Warning: you missed ${who}'s L${r.level} interview`,
          message: `You were on the panel for ${who}'s L${r.level} interview for ${role} on ${when} and did not join, without telling anyone beforehand. The candidate was left waiting and has been sent an apology. This has been reported to the HR head${n ? `; you have missed a booked interview without notice ${times(n)} in the last ${PANEL_NO_SHOW_WINDOW_DAYS} days` : ""}. If you cannot make an interview, say so in My interviews before it starts so a stand-in can be arranged.`,
          actionUrl: `${site}/interviews/mine`,
        },
      });
    } catch {
      /* the audit entry is the record */
    }
  }

  const heads = (await db.execute(sql`
    select distinct u.email from user_roles ur join users u on u.id = ur.user_id
     where ur.org_id = ${orgId} and ur.role = 'hr_head'`)) as unknown as { email: string }[];
  const lines = missed.map((m) => {
    const n = earlier.get(m.email) ?? 0;
    return `${m.name}${m.name === m.email ? "" : ` (${m.email})`}${n ? ` — missed ${times(n)} in ${PANEL_NO_SHOW_WINDOW_DAYS} days` : ""}`;
  });
  for (const { email } of heads) {
    try {
      await enqueueEmail({
        orgId,
        kind: "member_reminder",
        templateName: "member_reminder",
        toEmail: email,
        applicationId: r.applicationId,
        idempotencyKey: `panel-no-show-escalation:${r.id}:${email}`,
        templateData: {
          heading: `Panel no-show: ${who}'s L${r.level} interview`,
          message: `${who}'s L${r.level} interview for ${role} on ${when} did not happen: ${lines.join("; ")} did not join and gave no notice. Each has been warned and the candidate has been sent an apology. The Interview coordinator is proposing a stand-in for each, then new times — approve the stand-in on the hiring desk so the candidate is not lost.`,
          actionUrl: `${site}/desk`,
        },
      });
    } catch {
      /* the audit entry is the record */
    }
  }
  return missed;
}
