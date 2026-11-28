/**
 * Organisation scoring template: the candidate-scoring weights every new
 * requisition starts from — the six built-ins (0 switches one off) plus up to
 * four of the organisation's own dimensions, totalling 100. The same weights
 * drive the full match score and the ranked shortlist, so the template is how an
 * organisation makes "what good looks like" its default across roles.
 *
 * Changing it needs the HR head, the CBO or an owner and is audited. It never
 * rewrites existing roles on its own: "apply to open roles" goes through each
 * role's own weight rules (not in approval, not closed, leaders for approved).
 */
import { and, eq, notInArray } from "drizzle-orm";

import { organizations, requisitions } from "@db/schema";
import { db } from "../server/db";
import {
  IN_APPROVAL,
  saveRequisitionWeightsCore,
  weightsProblem,
  type LifecycleActor,
} from "./requisitions.server";

export type ScoringTemplate = {
  skills: number;
  experience: number;
  career: number;
  impact: number;
  education: number;
  social: number;
  custom: { key: string; label: string; hint: string; weight: number }[];
};

/** The platform default split (the requisition column defaults). */
export const PLATFORM_DEFAULT_TEMPLATE: ScoringTemplate = {
  skills: 40,
  experience: 15,
  career: 10,
  impact: 10,
  education: 10,
  social: 15,
  custom: [],
};

export async function getScoringTemplate(
  orgId: string,
): Promise<{ template: ScoringTemplate; isDefault: boolean }> {
  const [row] = await db
    .select({ t: organizations.scoringTemplate })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.t
    ? { template: row.t, isDefault: false }
    : { template: PLATFORM_DEFAULT_TEMPLATE, isDefault: true };
}

/** Requisition insert columns for the organisation's template (empty when none is set). */
export async function templateColumns(orgId: string): Promise<
  Partial<{
    weightSkills: number;
    weightExperience: number;
    weightCareer: number;
    weightImpact: number;
    weightEducation: number;
    weightSocial: number;
    customWeights: ScoringTemplate["custom"];
  }>
> {
  const { template, isDefault } = await getScoringTemplate(orgId);
  if (isDefault) return {};
  return {
    weightSkills: template.skills,
    weightExperience: template.experience,
    weightCareer: template.career,
    weightImpact: template.impact,
    weightEducation: template.education,
    weightSocial: template.social,
    customWeights: template.custom,
  };
}

/** Key-order-independent form (jsonb does not keep key order). */
function canonical(t: ScoringTemplate): string {
  const { custom, ...w } = t;
  return JSON.stringify([
    Object.entries(w).sort(([a], [b]) => a.localeCompare(b)),
    custom.map((d) => [d.key, d.label, d.hint, d.weight]),
  ]);
}

async function assertLeader(actor: LifecycleActor) {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(
    actor.userId,
    actor.orgId,
    ["hr_head", "president_cbo"],
    "Only the HR head, the CBO or an owner can change the scoring template.",
  );
}

/** Save (or, with null, reset to the platform default) the template. Audited. */
export async function saveScoringTemplateCore(
  actor: LifecycleActor,
  next: ScoringTemplate | null,
): Promise<{ changed: boolean }> {
  await assertLeader(actor);
  if (next) {
    const { custom, ...w } = next;
    const problem = weightsProblem(w, custom);
    if (problem) throw new Error(problem);
  }
  const before = await getScoringTemplate(actor.orgId);
  const after = next ?? PLATFORM_DEFAULT_TEMPLATE;
  if (canonical(before.template) === canonical(after) && before.isDefault === !next)
    return { changed: false };
  await db
    .update(organizations)
    .set({ scoringTemplate: next })
    .where(eq(organizations.id, actor.orgId));
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "org.scoring_template_changed",
    entityType: "organization",
    entityId: actor.orgId,
    detail: { before: before.isDefault ? null : before.template, after: next },
  });
  return { changed: true };
}

/**
 * Apply the template to the organisation's open roles, each through its own
 * weight rules (and audit). Roles in approval or closed are reported, not changed.
 */
export async function applyTemplateToOpenRolesCore(actor: LifecycleActor): Promise<{
  applied: string[];
  unchanged: string[];
  skipped: { code: string; reason: string }[];
}> {
  await assertLeader(actor);
  const { template } = await getScoringTemplate(actor.orgId);
  const { custom, ...w } = template;
  const roles = await db
    .select({ id: requisitions.id, code: requisitions.code, status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.orgId, actor.orgId), notInArray(requisitions.status, ["closed"])));
  const out = {
    applied: [] as string[],
    unchanged: [] as string[],
    skipped: [] as { code: string; reason: string }[],
  };
  for (const r of roles) {
    if (IN_APPROVAL.includes(r.status as (typeof IN_APPROVAL)[number])) {
      out.skipped.push({ code: r.code, reason: "in approval" });
      continue;
    }
    try {
      const res = await saveRequisitionWeightsCore(actor, r.id, w, custom);
      (res.changed ? out.applied : out.unchanged).push(r.code);
    } catch (e) {
      out.skipped.push({ code: r.code, reason: e instanceof Error ? e.message : "failed" });
    }
  }
  return out;
}
