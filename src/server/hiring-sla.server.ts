/**
 * The end-to-end hiring SLA (organizations.hiring_sla_days, default 5): from
 * application to a released offer. Run by the agent tick, this tells the role's
 * hiring desk once when a candidate falls behind the pace for their stage
 * (at risk) and once when they pass the SLA. Applications already long past it
 * when this first runs are marked without a message, so the desk is not flooded.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { applications, candidates, organizations } from "@db/schema";
import { db } from "./db";
import { canonical, hiringSla, STAGE_LABEL, type Stage } from "@/lib/lifecycle";

const SLA_STAGES: Stage[] = [
  "sourced",
  "applied",
  "ai_screened",
  "shortlisted",
  "l1",
  "l2",
  "l3",
  "offer_pending",
];

/** Older than the SLA by more than this: marked quietly (pre-existing backlog). */
const QUIET_AFTER_DAYS = 2;

export async function sweepHiringSla(orgId?: string, now = Date.now()): Promise<number> {
  const rows = await db
    .select({
      id: applications.id,
      orgId: applications.orgId,
      requisitionId: applications.requisitionId,
      stage: applications.stage,
      appliedAt: applications.appliedAt,
      slaFlag: applications.slaFlag,
      name: candidates.fullName,
      slaDays: organizations.hiringSlaDays,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(organizations, eq(organizations.id, applications.orgId))
    .where(
      and(
        orgId ? eq(applications.orgId, orgId) : sql`true`,
        inArray(applications.stage, SLA_STAGES as never[]),
        sql`${applications.slaFlag} is distinct from 'breached'`,
        // Not yet behind even the earliest stage's pace: nothing to check.
        sql`${applications.appliedAt} < ${new Date(now - 0.2 * 864e5).toISOString()}::timestamptz`,
      ),
    )
    .limit(500);
  let told = 0;
  for (const r of rows) {
    const s = hiringSla(r.stage as Stage, r.appliedAt, r.slaDays, now);
    if (!s || s.state === "on_track") continue;
    if (s.state === r.slaFlag) continue;
    const [claimed] = await db
      .update(applications)
      .set({ slaFlag: s.state })
      .where(
        and(
          eq(applications.id, r.id),
          sql`${applications.slaFlag} is not distinct from ${r.slaFlag}`,
        ),
      )
      .returning({ id: applications.id });
    if (!claimed || !r.orgId) continue;
    if (s.elapsedDays > r.slaDays + QUIET_AFTER_DAYS) continue;
    const stage = STAGE_LABEL[canonical(r.stage as Stage)] ?? r.stage;
    const body =
      s.state === "breached"
        ? `${r.name} has passed the ${r.slaDays}-day hiring SLA: ${s.elapsedDays} days since applying, still at ${stage}.`
        : `${r.name} is behind the ${r.slaDays}-day hiring SLA at ${stage}: ${s.elapsedDays} days since applying, ${s.daysLeft} left to release an offer.`;
    try {
      const desk = await import("./desk/desk.server");
      const conv = await desk.conversationForRequisition(r.orgId, r.requisitionId);
      if (conv) {
        await desk.postMessage(conv, { role: "desk", body });
        told++;
      }
    } catch {
      /* the Reports page shows it either way */
    }
  }
  return told;
}
