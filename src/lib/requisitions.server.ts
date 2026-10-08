/**
 * Requisition and JD lifecycle cores, shared by the server functions (people)
 * and agent tools (agents acting for a person). Every core takes the acting
 * member, checks the same roles the UI path always checked, predicates every
 * query on the organisation, and emits the domain event the orchestrator
 * listens to (docs/agentic-plan.md §3.1).
 */
import { and, desc, eq, like } from "drizzle-orm";

import { db } from "../server/db";
import { jobDescriptions, requisitions } from "@db/schema";
import { emitAgentEvent } from "../server/agents/events";
import { assertRole, type AppRole } from "./auth.middleware";

export type LifecycleActor = {
  orgId: string;
  userId: string;
  memberEmail: string;
  /** Set when an agent performs the action for this member (recorded in trails). */
  via?: "agent";
};

export type ReqStatus =
  | "draft"
  | "pending_dh"
  | "pending_hr"
  | "pending_cbo"
  | "approved"
  | "rejected"
  | "on_hold"
  | "closed";

/**
 * The requisition approval chain (DH → HR → CBO): each target status names the
 * legal source statuses and the role that may make the hop. Org owners pass
 * every role check (assertRole semantics).
 */
export const REQ_TRANSITIONS: Partial<
  Record<ReqStatus, { from: ReqStatus[]; role?: AppRole | AppRole[] }>
> = {
  draft: { from: ["draft", "rejected", "on_hold"] },
  pending_dh: { from: ["draft", "rejected", "on_hold"] },
  pending_hr: { from: ["pending_dh"], role: "department_head" },
  pending_cbo: { from: ["pending_hr"], role: "hr_head" },
  approved: { from: ["pending_cbo"], role: "president_cbo" },
  rejected: {
    from: ["pending_dh", "pending_hr", "pending_cbo"],
    role: ["department_head", "hr_head", "president_cbo"],
  },
  on_hold: {
    from: ["draft", "pending_dh", "pending_hr", "pending_cbo", "approved"],
    role: ["hr_head", "president_cbo"],
  },
  closed: { from: ["approved", "on_hold"], role: ["hr_head", "president_cbo"] },
};

/** The next status an approver at `status` moves the requisition to. */
export const NEXT_APPROVAL: Partial<Record<ReqStatus, ReqStatus>> = {
  pending_dh: "pending_hr",
  pending_hr: "pending_cbo",
  pending_cbo: "approved",
};

/** Which role approves a requisition waiting at `status`. */
export const APPROVER_ROLE: Partial<Record<ReqStatus, AppRole>> = {
  pending_dh: "department_head",
  pending_hr: "hr_head",
  pending_cbo: "president_cbo",
};

export type RequisitionFields = {
  title: string;
  departmentId: string | null;
  location: string;
  openings: number;
  experienceMin: number;
  experienceMax: number;
  budgetCtc: number;
  ctcBandMin: number | null;
  ctcBandMax: number | null;
  maxNoticePeriodDays: number | null;
  workAuthorizationRequired: string | null;
  hiringManager: string | null;
  mustHaveSkills: string[];
  goodToHaveSkills: string[];
  responsibilities: string | null;
  educationRequirement: string | null;
  billingType: string;
  engagementType: string;
  clientName: string | null;
  costCenter: string | null;
};

export async function createRequisitionCore(
  actor: LifecycleActor,
  f: RequisitionFields,
  status: "draft" | "pending_dh",
): Promise<{ id: string; code: string }> {
  const year = new Date().getFullYear();
  const [latest] = await db
    .select({ code: requisitions.code })
    .from(requisitions)
    .where(and(eq(requisitions.orgId, actor.orgId), like(requisitions.code, `REQ-${year}-%`)))
    .orderBy(desc(requisitions.code))
    .limit(1);
  const next = Number(latest?.code?.match(/REQ-\d{4}-(\d+)$/)?.[1] ?? 0) + 1;
  const code = `REQ-${year}-${String(next).padStart(3, "0")}`;

  const [row] = await db
    .insert(requisitions)
    .values({
      orgId: actor.orgId,
      code,
      title: f.title,
      departmentId: f.departmentId,
      location: f.location,
      openings: f.openings || 1,
      experienceMin: f.experienceMin || 0,
      experienceMax: f.experienceMax || 0,
      budgetCtc: String(f.budgetCtc || 0),
      ctcBandMin: f.ctcBandMin != null ? String(f.ctcBandMin) : null,
      ctcBandMax: f.ctcBandMax != null ? String(f.ctcBandMax) : null,
      maxNoticePeriodDays: f.maxNoticePeriodDays,
      workAuthorizationRequired: f.workAuthorizationRequired,
      hiringManager: f.hiringManager,
      mustHaveSkills: f.mustHaveSkills,
      goodToHaveSkills: f.goodToHaveSkills,
      responsibilities: f.responsibilities,
      educationRequirement: f.educationRequirement,
      billingType: f.billingType,
      engagementType: f.engagementType,
      clientName: f.clientName,
      costCenter: f.costCenter,
      createdBy: actor.userId,
      status,
    })
    .returning({ id: requisitions.id });

  await emitAgentEvent({
    orgId: actor.orgId,
    type: "requisition.created",
    subjectType: "requisition",
    subjectId: row!.id,
    actorUserId: actor.userId,
    payload: { status, via: actor.via ?? null },
  });
  return { id: row!.id, code };
}

/** Fields an agent (or person) may change while a requisition is still a draft. */
export type RequisitionDraftPatch = {
  [
    K in keyof Pick<
      RequisitionFields,
      | "title"
      | "departmentId"
      | "location"
      | "openings"
      | "experienceMin"
      | "experienceMax"
      | "mustHaveSkills"
      | "goodToHaveSkills"
      | "responsibilities"
      | "educationRequirement"
      | "hiringManager"
      | "maxNoticePeriodDays"
    >
  ]?: RequisitionFields[K] | undefined;
};

export async function updateRequisitionDraftCore(
  actor: LifecycleActor,
  id: string,
  patch: RequisitionDraftPatch,
): Promise<void> {
  const [current] = await db
    .select({ status: requisitions.status })
    .from(requisitions)
    .where(and(eq(requisitions.id, id), eq(requisitions.orgId, actor.orgId)))
    .limit(1);
  if (!current) throw new Error("Requisition not found.");
  if (!["draft", "rejected", "on_hold"].includes(current.status)) {
    throw new Error(`A ${current.status} requisition can no longer be edited.`);
  }
  const set: Partial<typeof requisitions.$inferInsert> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  }
  if (!Object.keys(set).length) return;
  await db
    .update(requisitions)
    .set(set)
    .where(and(eq(requisitions.id, id), eq(requisitions.orgId, actor.orgId)));
}

export async function advanceRequisitionCore(
  actor: LifecycleActor,
  input: { id: string; status: ReqStatus; comment?: string | null },
): Promise<{ from: ReqStatus; to: ReqStatus }> {
  const [current] = await db
    .select({ status: requisitions.status, approvalTrail: requisitions.approvalTrail })
    .from(requisitions)
    .where(and(eq(requisitions.id, input.id), eq(requisitions.orgId, actor.orgId)))
    .limit(1);
  if (!current) throw new Error("Requisition not found.");

  const rule = REQ_TRANSITIONS[input.status];
  if (!rule || !rule.from.includes(current.status)) {
    throw new Error(`A requisition cannot move from ${current.status} to ${input.status}.`);
  }
  if (rule.role) await assertRole(actor.userId, actor.orgId, rule.role);

  // The approval trail is evidence — rebuilt server-side, never client-supplied.
  const prior = Array.isArray(current.approvalTrail) ? current.approvalTrail : [];
  const trail = [
    ...prior,
    {
      from: current.status,
      to: input.status,
      actor: actor.memberEmail,
      decision: input.status,
      comment: input.comment ?? null,
      at: new Date().toISOString(),
      ...(actor.via ? { via: actor.via } : {}),
    },
  ];
  await db
    .update(requisitions)
    .set({ status: input.status, approvalTrail: trail as never })
    .where(and(eq(requisitions.id, input.id), eq(requisitions.orgId, actor.orgId)));

  // Closing a role takes its job-board postings down with it — best-effort.
  if (input.status === "closed") {
    const { closePostingsForRequisition } = await import("../server/boards/publish.server");
    await closePostingsForRequisition({
      orgId: actor.orgId,
      actor: { memberEmail: actor.memberEmail, userId: actor.userId },
      requisitionId: input.id,
    }).catch(() => undefined);
  }

  await emitAgentEvent({
    orgId: actor.orgId,
    type: "requisition.status_changed",
    subjectType: "requisition",
    subjectId: input.id,
    actorUserId: actor.userId,
    payload: { from: current.status, to: input.status, via: actor.via ?? null },
  });
  return { from: current.status, to: input.status };
}

export async function updateRequisitionCompensationCore(
  actor: LifecycleActor,
  input: {
    id: string;
    budgetCtc: number;
    ctcBandMin: number | null;
    ctcBandMax: number | null;
    careerLevel?: string | null;
  },
): Promise<void> {
  await db
    .update(requisitions)
    .set({
      budgetCtc: String(input.budgetCtc || 0),
      ctcBandMin: input.ctcBandMin != null ? String(input.ctcBandMin) : null,
      ctcBandMax: input.ctcBandMax != null ? String(input.ctcBandMax) : null,
      careerLevel: input.careerLevel || null,
    })
    .where(and(eq(requisitions.id, input.id), eq(requisitions.orgId, actor.orgId)));
}

export type ScoringWeights = {
  skills: number;
  experience: number;
  career: number;
  impact: number;
  education: number;
  social: number;
};

export async function saveRequisitionWeightsCore(
  actor: LifecycleActor,
  id: string,
  w: ScoringWeights,
): Promise<void> {
  await db
    .update(requisitions)
    .set({
      weightSkills: w.skills,
      weightExperience: w.experience,
      weightCareer: w.career,
      weightImpact: w.impact,
      weightEducation: w.education,
      weightSocial: w.social,
    })
    .where(and(eq(requisitions.id, id), eq(requisitions.orgId, actor.orgId)));
}

export async function setRequisitionIjpCore(
  actor: LifecycleActor,
  id: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(requisitions)
    .set({ ijpEnabled: enabled, ijpPostedAt: enabled ? new Date() : null })
    .where(and(eq(requisitions.id, id), eq(requisitions.orgId, actor.orgId)));
}

/* ------------------------------------------------------------ JD versions */

export type JdContent = {
  purpose: string;
  responsibilities: string;
  must_have: string[];
  good_to_have: string[];
  qualifications: string;
  success_factors: string;
  reporting_to: string;
  full_text: string;
};

/** File a JD as the next version, waiting for Department Head review. */
export async function saveJobDescriptionCore(
  actor: LifecycleActor,
  input: {
    requisitionId: string;
    jd: JdContent;
    templateId?: string | null;
    templateName?: string | null;
  },
): Promise<{ id: string; version: number }> {
  const [requisition] = await db
    .select({ id: requisitions.id })
    .from(requisitions)
    .where(and(eq(requisitions.id, input.requisitionId), eq(requisitions.orgId, actor.orgId)))
    .limit(1);
  if (!requisition) throw new Error("Requisition not found");

  const [latest] = await db
    .select({ version: jobDescriptions.version })
    .from(jobDescriptions)
    .where(
      and(
        eq(jobDescriptions.requisitionId, input.requisitionId),
        eq(jobDescriptions.orgId, actor.orgId),
      ),
    )
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;

  const [row] = await db
    .insert(jobDescriptions)
    .values({
      requisitionId: input.requisitionId,
      orgId: actor.orgId,
      version,
      status: "pending_dh",
      purpose: input.jd.purpose,
      responsibilities: input.jd.responsibilities,
      mustHave: input.jd.must_have,
      goodToHave: input.jd.good_to_have,
      qualifications: input.jd.qualifications,
      successFactors: input.jd.success_factors,
      reportingTo: input.jd.reporting_to,
      fullText: input.jd.full_text,
      templateId: input.templateId || null,
      templateName: input.templateName || null,
    })
    .returning({ id: jobDescriptions.id });

  await emitAgentEvent({
    orgId: actor.orgId,
    type: "jd.submitted",
    subjectType: "jd",
    subjectId: row!.id,
    actorUserId: actor.userId,
    payload: { requisitionId: input.requisitionId, version, via: actor.via ?? null },
  });
  return { id: row!.id, version };
}

const JD_REVIEWERS: AppRole[] = ["department_head", "hr_head", "president_cbo"];

async function jdForReview(actor: LifecycleActor, id: string) {
  await assertRole(
    actor.userId,
    actor.orgId,
    JD_REVIEWERS,
    "Only a department head, HR head or the CBO can review a job description.",
  );
  const [jd] = await db
    .select({ status: jobDescriptions.status, requisitionId: jobDescriptions.requisitionId })
    .from(jobDescriptions)
    .where(and(eq(jobDescriptions.id, id), eq(jobDescriptions.orgId, actor.orgId)))
    .limit(1);
  if (!jd) throw new Error("Job description not found.");
  if (jd.status === "approved") throw new Error("This version is already approved.");
  return jd;
}

/** Approve a JD version — a department-head-and-above decision. */
export async function approveJobDescriptionCore(
  actor: LifecycleActor,
  input: { id: string; fullText?: string | null },
): Promise<void> {
  const jd = await jdForReview(actor, input.id);
  await db
    .update(jobDescriptions)
    // Keep the drafted text unless the approver supplied an edited version
    // (approving from an agent card or without edits used to erase it).
    .set({
      status: "approved",
      ...(input.fullText?.trim() ? { fullText: input.fullText } : {}),
    })
    .where(and(eq(jobDescriptions.id, input.id), eq(jobDescriptions.orgId, actor.orgId)));
  await emitAgentEvent({
    orgId: actor.orgId,
    type: "jd.approved",
    subjectType: "jd",
    subjectId: input.id,
    actorUserId: actor.userId,
    payload: { requisitionId: jd.requisitionId },
  });
}

/** Send a JD version back to its author with the reviewer's comment. */
export async function requestJdChangesCore(
  actor: LifecycleActor,
  input: { id: string; comment: string },
): Promise<void> {
  const jd = await jdForReview(actor, input.id);
  await db
    .update(jobDescriptions)
    .set({ status: "changes_requested", approverComment: input.comment })
    .where(and(eq(jobDescriptions.id, input.id), eq(jobDescriptions.orgId, actor.orgId)));
  await emitAgentEvent({
    orgId: actor.orgId,
    type: "jd.changes_requested",
    subjectType: "jd",
    subjectId: input.id,
    actorUserId: actor.userId,
    payload: { requisitionId: jd.requisitionId, comment: input.comment },
  });
}

/** Resolve the member identity an agent acts as. */
export async function actorFor(orgId: string, userId: string): Promise<LifecycleActor> {
  const { activeOrgOf } = await import("./auth.middleware");
  const org = await activeOrgOf(userId);
  if (!org || org.orgId !== orgId)
    throw new Error("The person this agent works for has left the organisation.");
  return { orgId, userId, memberEmail: org.memberEmail, via: "agent" };
}
