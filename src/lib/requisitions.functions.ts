/**
 * Org-scoped write layer for requisitions, JD versions, departments and the
 * internal job posting (IJP) apply flow. Every function verifies the caller's
 * organisation (`requireOrg`) and predicates every read/write on it.
 */
import { and, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { applications, candidates, departments, requisitions } from "@db/schema";
import { assertRole, requireOrg, requireRole } from "./auth.middleware";

const ReqStatus = z.enum([
  "draft",
  "pending_dh",
  "pending_hr",
  "pending_cbo",
  "approved",
  "rejected",
  "on_hold",
  "closed",
]);

/* ------------------------------------------------------------- requisitions */

/** Approve/advance a requisition: role-checked status bump, trail rebuilt server-side. */
export const advanceRequisition = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: ReqStatus,
        comment: z.string().max(2000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { advanceRequisitionCore } = await import("./requisitions.server");
    await advanceRequisitionCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      { id: data.id, status: data.status, comment: data.comment ?? null },
    );
    return { ok: true as const };
  });

/**
 * Delete a requisition that never went anywhere: drafts only, and only while
 * nothing references them (no applications). HR head / owner — deletion is a
 * privileged, audited action; anything with a history must use the status
 * machine (reject / close) so the trail stays intact.
 */
export const deleteRequisition = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        reason: z.string().max(500).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    // Same trust level as closing: HR head or the org's president (owners pass).
    await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
    const [req] = await db
      .select({
        id: requisitions.id,
        code: requisitions.code,
        title: requisitions.title,
        status: requisitions.status,
      })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.id), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!req) throw new Error("Requisition not found.");
    if (req.status !== "draft")
      throw new Error(
        "Only a draft requisition can be deleted. Reject or close it instead so the approval trail is kept.",
      );

    const appCount = await db.$count(
      applications,
      and(eq(applications.requisitionId, req.id), eq(applications.orgId, context.orgId)),
    );
    if (appCount > 0)
      throw new Error(
        `This requisition has ${appCount} application(s) — it can no longer be deleted. Reject or close it instead.`,
      );

    await db
      .delete(requisitions)
      .where(and(eq(requisitions.id, req.id), eq(requisitions.orgId, context.orgId)));

    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "requisition.delete",
      entityType: "requisition",
      entityId: req.id,
      detail: { code: req.code, title: req.title, reason: data.reason?.trim() || null },
    });
    return { ok: true as const, code: req.code };
  });

/** Publish / unpublish an approved requisition on the internal job board. */
export const setRequisitionIjp = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { setRequisitionIjpCore } = await import("./requisitions.server");
    await setRequisitionIjpCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data.id,
      data.enabled,
    );
    return { ok: true as const };
  });

/** Employee-facing note shown on the internal job board. */
export const setRequisitionIjpNotes = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().uuid(), notes: z.string().nullish() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    await db
      .update(requisitions)
      .set({ ijpNotes: data.notes || null })
      .where(and(eq(requisitions.id, data.id), eq(requisitions.orgId, context.orgId)));
    return { ok: true as const };
  });

/** Persist the six match weights configured for this requisition. */
export const saveRequisitionWeights = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        weights: z.object({
          skills: z.number().int(),
          experience: z.number().int(),
          career: z.number().int(),
          impact: z.number().int(),
          education: z.number().int(),
          social: z.number().int(),
        }),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { saveRequisitionWeightsCore } = await import("./requisitions.server");
    await saveRequisitionWeightsCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      data.id,
      data.weights,
    );
    return { ok: true as const };
  });

/** Write budget CTC + band (e.g. chosen from a market benchmark) and the ladder level they came from. */
export const updateRequisitionCompensation = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        budgetCtc: z.string(),
        ctcBandMin: z.string(),
        ctcBandMax: z.string(),
        careerLevel: z.string().nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { updateRequisitionCompensationCore } = await import("./requisitions.server");
    await updateRequisitionCompensationCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      {
        id: data.id,
        budgetCtc: Number(data.budgetCtc) || 0,
        ctcBandMin: data.ctcBandMin ? Number(data.ctcBandMin) : null,
        ctcBandMax: data.ctcBandMax ? Number(data.ctcBandMax) : null,
        careerLevel: data.careerLevel ?? null,
      },
    );
    return { ok: true as const };
  });

/* ------------------------------------------------------------ JD versions */

const JdVersion = z.object({
  purpose: z.string(),
  responsibilities: z.string(),
  must_have: z.array(z.string()),
  good_to_have: z.array(z.string()),
  qualifications: z.string(),
  success_factors: z.string(),
  reporting_to: z.string(),
  full_text: z.string(),
});

/**
 * File a drafted or imported JD as the next version for Department Head
 * review. The version number is computed server-side so concurrent drafts
 * never collide on the same number.
 */
export const saveJobDescription = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        jd: JdVersion,
        /** Content template the draft followed — lineage only, no FK. */
        templateId: z.string().uuid().nullish(),
        templateName: z.string().max(80).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { saveJobDescriptionCore } = await import("./requisitions.server");
    await saveJobDescriptionCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      {
        requisitionId: data.requisitionId,
        jd: data.jd,
        templateId: data.templateId ?? null,
        templateName: data.templateName ?? null,
      },
    );
    return { ok: true as const };
  });

/** Approve a JD version — a department-head-and-above decision. */
export const approveJobDescription = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().uuid(), fullText: z.string().nullish() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { approveJobDescriptionCore } = await import("./requisitions.server");
    await approveJobDescriptionCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      { id: data.id, fullText: data.fullText ?? null },
    );
    return { ok: true as const };
  });

/** Send a JD version back with the reviewer's comment — department head and above. */
export const requestJdChanges = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().uuid(), comment: z.string().min(1).max(4000) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { requestJdChangesCore } = await import("./requisitions.server");
    await requestJdChangesCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      { id: data.id, comment: data.comment },
    );
    return { ok: true as const };
  });

/**
 * Keep the requisition's scoring baseline in sync with an imported JD. Only
 * the fields the caller sends are written — the blanks-fill-in-never-overwrite
 * policy is decided against the live requisition row before the call.
 */
export const syncRequisitionFromJd = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        mustHaveSkills: z.array(z.string()).optional(),
        goodToHaveSkills: z.array(z.string()).optional(),
        experienceMin: z.number().int().optional(),
        experienceMax: z.number().int().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const patch: Partial<typeof requisitions.$inferInsert> = {};
    if (data.mustHaveSkills) patch.mustHaveSkills = data.mustHaveSkills;
    if (data.goodToHaveSkills) patch.goodToHaveSkills = data.goodToHaveSkills;
    if (data.experienceMin !== undefined) patch.experienceMin = data.experienceMin;
    if (data.experienceMax !== undefined) patch.experienceMax = data.experienceMax;
    if (Object.keys(patch).length === 0) return { ok: true as const };

    await db
      .update(requisitions)
      .set(patch)
      .where(and(eq(requisitions.id, data.id), eq(requisitions.orgId, context.orgId)));
    return { ok: true as const };
  });

/* ------------------------------------------------------------- applications */

/**
 * Attach talent-pool candidates to a requisition as applications (source
 * defaults to "talent_pool"). A candidate already in the pipeline trips the
 * unique (requisition, candidate) index and the error propagates, exactly as
 * the PostgREST call did.
 */
export const addApplicationsToRequisition = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        candidateIds: z.array(z.string().uuid()).min(1).max(200),
        source: z.string().min(1).default("talent_pool"),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { addApplicationsCore } = await import("./pipeline.server");
    const r = await addApplicationsCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      { requisitionId: data.requisitionId, candidateIds: data.candidateIds, source: data.source },
    );
    return { ok: true as const, added: r.added };
  });

/* -------------------------------------------------------- create requisition */

/**
 * Raise a manpower requisition. The per-org `code` (REQ-YYYY-NNN) is computed
 * server-side from the highest number already issued this year: the client's
 * list can be stale or half-loaded, and a repeated number trips the per-org
 * unique index `requisitions_org_code_key` with a raw database error.
 */
export const createRequisition = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        title: z.string().min(1),
        departmentId: z.string().uuid().nullish(),
        location: z.string(),
        openings: z.string(),
        experienceMin: z.string(),
        experienceMax: z.string(),
        budgetCtc: z.string(),
        ctcBandMin: z.string(),
        ctcBandMax: z.string(),
        maxNoticePeriodDays: z.string(),
        workAuthorizationRequired: z.string(),
        hiringManager: z.string(),
        mustHaveSkills: z.array(z.string()),
        goodToHaveSkills: z.array(z.string()),
        responsibilities: z.string(),
        educationRequirement: z.string(),
        billingType: z.string(),
        engagementType: z.string(),
        clientName: z.string(),
        costCenter: z.string(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { createRequisitionCore } = await import("./requisitions.server");
    const num = (v: string) => Number(v) || 0;
    const { code } = await createRequisitionCore(
      { orgId: context.orgId, userId: context.userId, memberEmail: context.memberEmail },
      {
        title: data.title,
        departmentId: data.departmentId || null,
        location: data.location,
        openings: num(data.openings) || 1,
        experienceMin: num(data.experienceMin),
        experienceMax: num(data.experienceMax),
        budgetCtc: num(data.budgetCtc),
        ctcBandMin: data.ctcBandMin ? num(data.ctcBandMin) : null,
        ctcBandMax: data.ctcBandMax ? num(data.ctcBandMax) : null,
        maxNoticePeriodDays: data.maxNoticePeriodDays ? num(data.maxNoticePeriodDays) : null,
        workAuthorizationRequired: data.workAuthorizationRequired || null,
        hiringManager: data.hiringManager || null,
        mustHaveSkills: data.mustHaveSkills,
        goodToHaveSkills: data.goodToHaveSkills,
        responsibilities: data.responsibilities || null,
        educationRequirement: data.educationRequirement || null,
        billingType: data.billingType,
        engagementType: data.engagementType,
        clientName: data.clientName || null,
        costCenter: data.costCenter || null,
      },
      "pending_dh",
    );
    return { ok: true as const, code };
  });

/* ------------------------------------------------------- job card overrides */

const JobCardZoneInput = z.object({
  slot: z.enum(["role", "skills", "experience", "location", "contact", "org"]),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().min(1).max(100),
  h: z.number().min(1).max(100),
  fontSize: z.number().min(8).max(200),
  align: z.enum(["left", "center", "right"]).default("left"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  mask: z.boolean().optional(),
  fontFamily: z.enum(["system", "serif", "mono"]).nullish(),
});

/**
 * TA-corrected job-card layout and slot values for this requisition. Overrides
 * ride on top of the selected template; empty object = pure template defaults.
 */
export const saveJobCardOverrides = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        zones: z.array(JobCardZoneInput).max(12),
        values: z
          .object({
            role: z.string().max(120).optional(),
            location: z.string().max(160).optional(),
            skills: z.array(z.string().max(60)).max(8).optional(),
            contact: z.string().max(160).optional(),
          })
          .default({}),
        theme: z
          .object({
            overlayOpacity: z.number().int().min(0).max(75).optional(),
            textColor: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional(),
            backgroundBrightness: z.number().int().min(50).max(130).optional(),
            accentColor: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional(),
          })
          .optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await db
      .update(requisitions)
      .set({
        jobCardOverrides: {
          zones: data.zones,
          values: data.values,
          ...(data.theme ? { theme: data.theme } : {}),
        },
      })
      .where(and(eq(requisitions.id, data.id), eq(requisitions.orgId, context.orgId)));
    return { ok: true as const };
  });

/* -------------------------------------------------------------- departments */

/** Quick-add a department straight from the requisition form; returns its id. */
export const createDepartment = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) => z.object({ name: z.string().min(1) }).parse(data))
  .handler(async ({ data, context }) => {
    const [row] = await db
      .insert(departments)
      .values({
        orgId: context.orgId,
        name: data.name,
        budgetedHeadcount: 0,
        budgetedCost: "0",
      })
      .returning({ id: departments.id });
    return { id: row?.id ?? null };
  });

/** Add a department to the workforce plan from the budgets panel. */
export const addDepartment = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        name: z.string().min(1),
        headName: z.string(),
        budgetedHeadcount: z.string(),
        budgetedCost: z.string(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await db.insert(departments).values({
      orgId: context.orgId,
      name: data.name.trim(),
      headName: data.headName.trim() || null,
      budgetedHeadcount: Number(data.budgetedHeadcount) || 0,
      budgetedCost: String(Number(data.budgetedCost) || 0),
    });
    return { ok: true as const };
  });

/* ---------------------------------------------------------- IJP apply flow */

/**
 * Employee applies to an internal job posting. The applicant's identity comes
 * from the form (the recruiter surface logs it), while tenancy comes only from
 * the session: the requisition and every write are org-scoped by `requireOrg`.
 * Re-uses an existing candidate with the same work email, otherwise registers
 * one tagged `is_internal`, then raises the IJP application (duplicate
 * applications trip the unique index and the error propagates).
 */
export const applyInternally = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .inputValidator((data: unknown) =>
    z
      .object({
        requisitionId: z.string().uuid(),
        fullName: z.string().min(1),
        email: z.string().min(1),
        employeeId: z.string().min(1),
        currentDepartment: z.string(),
        experienceYears: z.string(),
        skills: z.string(),
        note: z.string(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const [requisition] = await db
      .select({ id: requisitions.id })
      .from(requisitions)
      .where(and(eq(requisitions.id, data.requisitionId), eq(requisitions.orgId, context.orgId)))
      .limit(1);
    if (!requisition) throw new Error("Requisition not found");

    const email = data.email.trim();
    const [existing] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.orgId, context.orgId), eq(candidates.email, email)))
      .limit(1);

    let candidateId = existing?.id ?? null;
    if (!candidateId) {
      const [row] = await db
        .insert(candidates)
        .values({
          orgId: context.orgId,
          fullName: data.fullName.trim(),
          email,
          source: "ijp",
          isInternal: true,
          employeeId: data.employeeId.trim(),
          currentDepartment: data.currentDepartment || null,
          experienceYears: String(Number(data.experienceYears) || 0),
          skills: data.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          resumeText: data.note || null,
        })
        .returning({ id: candidates.id });
      if (!row) throw new Error("Could not register the employee");
      candidateId = row.id;
    }

    await db.insert(applications).values({
      requisitionId: data.requisitionId,
      candidateId,
      orgId: context.orgId,
      source: "ijp",
    });
    return { ok: true as const, candidateId };
  });
