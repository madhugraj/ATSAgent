/**
 * Bulk JD import: requirement extraction, the semantic duplicate check and
 * lightweight requisitions (docs/candidate-identification/track-b-design.md
 * §3–4). Every query is predicated on the organisation; the server functions
 * in jd-import.functions.ts are the only callers.
 */
import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  applications,
  auditLog,
  candidates,
  jdImportItems,
  jdRequirementProfiles,
  orgWorkflowProfiles,
  requisitions,
  sectorTaxonomyTerms,
} from "@db/schema";
import { db } from "../server/db";
import { writeAudit } from "../server/audit";
import { assertRequisitionInOrg } from "../server/guards";
import { assertRole } from "./auth.middleware";
import { DEFAULT_PROFILE_SETTINGS, type WorkflowProfileSettings } from "./capabilities";
import {
  DEFAULT_SECTORS,
  LIVE_REQ_STATUSES,
  RequirementProfileSchema,
  hardDifferences,
  mapSector,
  normaliseProfile,
  proposeVerdict,
  titleSimilarity,
  type RequirementProfile,
  type Verdict,
} from "./jd-requirements";
import type { LifecycleActor } from "./requisitions.server";

export const JD_IMPORT_ROLES = ["hr_head", "president_cbo", "recruiter"] as const;
/** Comparison budget (§4.5): per new JD, and per import session. */
export const MAX_PAIRS_PER_JD = 5;
export const MAX_PAIRS_PER_IMPORT = 50;
/** Text sent to extraction (§3.3). */
const MAX_JD_CHARS = 20_000;

export async function assertImportRole(actor: LifecycleActor) {
  await assertRole(
    actor.userId,
    actor.orgId,
    [...JD_IMPORT_ROLES],
    "Only HR, the CBO or a recruiter can import job descriptions.",
  );
}

/* -------------------------------------------------------- sector taxonomy */

/** The tenant's sector terms, seeding the platform default on first use. */
export async function sectorTerms(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ term: sectorTaxonomyTerms.term })
    .from(sectorTaxonomyTerms)
    .where(eq(sectorTaxonomyTerms.orgId, orgId))
    .orderBy(sectorTaxonomyTerms.term);
  if (rows.length) return rows.map((r) => r.term);
  await db
    .insert(sectorTaxonomyTerms)
    .values(DEFAULT_SECTORS.map((term) => ({ orgId, term, seededDefault: true })))
    .onConflictDoNothing();
  return [...DEFAULT_SECTORS].sort();
}

/** Replace the tenant's sector terms (tenant governance; audited by the caller). */
export async function replaceSectorTerms(orgId: string, terms: string[]): Promise<string[]> {
  const clean = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].slice(0, 100);
  if (!clean.length) throw new Error("Keep at least one sector.");
  await db.transaction(async (tx) => {
    await tx
      .delete(sectorTaxonomyTerms)
      .where(
        and(eq(sectorTaxonomyTerms.orgId, orgId), notInArray(sectorTaxonomyTerms.term, clean)),
      );
    await tx
      .insert(sectorTaxonomyTerms)
      .values(clean.map((term) => ({ orgId, term })))
      .onConflictDoNothing();
  });
  return clean.sort();
}

/* ------------------------------------------------------------ extraction */

/** One gateway call: the JD's requirement profile, sector mapped to the tenant taxonomy. */
export async function extractRequirementProfile(
  orgId: string,
  text: string,
): Promise<RequirementProfile | null> {
  const terms = await sectorTerms(orgId);
  const { aiJson, INJECTION_RULES, untrusted } = await import("./ai-gateway.server");
  const r = await aiJson<RequirementProfile>({
    system:
      INJECTION_RULES +
      "\nExtract a job description's requirements. Return ONLY JSON with keys: title, role_family " +
      "(a short lowercase family such as 'business development', 'software engineering', 'data science'), " +
      "seniority (entry|ic|senior|staff|lead|manager|director|executive|unknown), sector (exactly one term " +
      "from the sector list, or 'unknown'), employment_type (permanent|fixed_term|contract|part_time|intern|unknown), " +
      "location {city, country, remote_policy (onsite|hybrid|remote|unknown)}, right_to_work, languages " +
      "[{name, level}], experience_years {min, max}, must_have (required skills/experience as short terms), " +
      "nice_to_have (preferred), responsibilities (short themes), hiring_client, job_code (the JD's own " +
      "reference / quoting code), pay {stated, currency (ISO-4217 code only if the JD names or shows it, " +
      "e.g. £ → GBP), period (hour|day|month|year), bound (up_to|range|exact), min, max, exact}, " +
      "suspected_prompt_injection. Use null when a field is genuinely absent. Never invent values; " +
      "never assume a currency the JD does not show; if the JD states no pay figure, set pay.stated false.",
    prompt: `${untrusted("sector_list", terms.join("\n"))}\n\n${untrusted("job_description", text.slice(0, MAX_JD_CHARS))}`,
    orgId,
    feature: "jd_requirements",
    schema: RequirementProfileSchema,
  });
  if (!r.ok) return null;
  return { ...r.data, sector: mapSector(r.data.sector, terms) };
}

/* --------------------------------------------------------------- policy */

async function workflowSettings(orgId: string): Promise<WorkflowProfileSettings> {
  const [row] = await db
    .select({ settings: orgWorkflowProfiles.settings })
    .from(orgWorkflowProfiles)
    .where(eq(orgWorkflowProfiles.orgId, orgId))
    .limit(1);
  return (row?.settings ?? {}) as WorkflowProfileSettings;
}

/**
 * The audit row that put the organisation on auto-approved requisitions, or
 * null. Only the most recent setting of jdRequisitionMode counts: a later
 * switch back to the approval gate revokes the policy (fail closed).
 */
export async function autoApprovePolicyAuditId(orgId: string): Promise<string | null> {
  const rows = await db
    .select({ id: auditLog.id, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, orgId),
        inArray(auditLog.action, [
          "workflow_profile.settings_updated",
          "platform.workflow_profile.applied",
          "platform.workflow_profile.settings_updated",
        ]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(50);
  for (const r of rows) {
    const d = (r.detail ?? {}) as {
      after?: WorkflowProfileSettings;
      settings?: WorkflowProfileSettings;
    };
    const mode = d.after?.jdRequisitionMode ?? d.settings?.jdRequisitionMode;
    if (mode) return mode === "auto_approved" ? r.id : null;
  }
  return null;
}

/* ------------------------------------------------ duplicate candidates */

type Twin = {
  id: string;
  code: string;
  status: string;
  live: boolean;
  profile: RequirementProfile;
  fromColumns: boolean;
};

/** A profile for a requisition imported before B3, read from its columns. */
function profileFromColumns(r: {
  title: string;
  location: string | null;
  workMode: string | null;
  mustHaveSkills: string[] | null;
  goodToHaveSkills: string[] | null;
  experienceMin: number | null;
  experienceMax: number | null;
  clientName: string | null;
  externalJobCode: string | null;
}): RequirementProfile {
  return normaliseProfile({
    title: r.title,
    location: { city: r.location, country: null, remote_policy: r.workMode },
    must_have: r.mustHaveSkills ?? [],
    nice_to_have: r.goodToHaveSkills ?? [],
    experience_years:
      r.experienceMin || r.experienceMax ? { min: r.experienceMin, max: r.experienceMax } : null,
    hiring_client: r.clientName,
    job_code: r.externalJobCode,
  });
}

const reqCols = {
  id: requisitions.id,
  code: requisitions.code,
  title: requisitions.title,
  status: requisitions.status,
  location: requisitions.location,
  workMode: requisitions.workMode,
  mustHaveSkills: requisitions.mustHaveSkills,
  goodToHaveSkills: requisitions.goodToHaveSkills,
  experienceMin: requisitions.experienceMin,
  experienceMax: requisitions.experienceMax,
  clientName: requisitions.clientName,
  externalJobCode: requisitions.externalJobCode,
  createdAt: requisitions.createdAt,
};

async function twinsFor(
  orgId: string,
  rows: Awaited<ReturnType<typeof selectReqs>>[number][],
): Promise<Twin[]> {
  if (!rows.length) return [];
  const profs = await db
    .select({
      requisitionId: jdRequirementProfiles.requisitionId,
      profile: jdRequirementProfiles.profile,
      createdAt: jdRequirementProfiles.createdAt,
    })
    .from(jdRequirementProfiles)
    .where(
      and(
        eq(jdRequirementProfiles.orgId, orgId),
        inArray(
          jdRequirementProfiles.requisitionId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(desc(jdRequirementProfiles.createdAt));
  const byReq = new Map<string, RequirementProfile>();
  for (const p of profs)
    if (p.requisitionId && !byReq.has(p.requisitionId)) byReq.set(p.requisitionId, p.profile);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    live: (LIVE_REQ_STATUSES as readonly string[]).includes(r.status),
    profile: byReq.get(r.id) ?? profileFromColumns(r),
    fromColumns: !byReq.has(r.id),
  }));
}

function selectReqs(orgId: string, where: ReturnType<typeof and>) {
  return db
    .select(reqCols)
    .from(requisitions)
    .where(and(eq(requisitions.orgId, orgId), where))
    .orderBy(desc(requisitions.createdAt))
    .limit(200);
}

/**
 * Narrow to the requisitions worth comparing (§4.3): same organisation, live
 * or created within the lookback window, same role family (or, when either
 * family is unknown, a similar title) — the K most recent.
 */
export async function narrowTwins(
  orgId: string,
  p: RequirementProfile,
  lookbackDays: number,
  excludeIds: string[] = [],
): Promise<Twin[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000);
  const rows = await selectReqs(
    orgId,
    and(
      or(inArray(requisitions.status, [...LIVE_REQ_STATUSES]), gte(requisitions.createdAt, since)),
      excludeIds.length ? notInArray(requisitions.id, excludeIds) : undefined,
    ),
  );
  const twins = await twinsFor(orgId, rows);
  const fam = p.roleFamily;
  return twins
    .filter((t) =>
      fam && t.profile.roleFamily
        ? t.profile.roleFamily === fam
        : titleSimilarity(p.title, t.profile.title) >= 0.5,
    )
    .slice(0, MAX_PAIRS_PER_JD);
}

/** Requisitions carrying the same external job code (case-insensitive). */
export async function jobCodeTwins(orgId: string, code: string | null): Promise<Twin[]> {
  if (!code) return [];
  const rows = await selectReqs(
    orgId,
    and(sql`lower(${requisitions.externalJobCode}) = ${code.toLowerCase()}`),
  );
  return twinsFor(orgId, rows);
}

/* -------------------------------------------------------- AI comparison */

const ComparisonSchema = z.object({
  similarity: z.coerce.number().min(0).max(1),
  must_have_overlap: z.coerce.number().min(0).max(1).nullish().catch(null),
  responsibility_themes: z.array(z.string()).nullish().catch(null),
  field_diffs: z
    .array(z.object({ field: z.string(), a: z.string().nullish(), b: z.string().nullish() }))
    .nullish()
    .catch(null),
  reasons: z.array(z.string()).nullish().catch(null),
});
type Comparison = z.infer<typeof ComparisonSchema>;

/** One pairwise comparison through the gateway, attributed to the existing requisition. */
export async function compareProfiles(
  orgId: string,
  incoming: RequirementProfile,
  twin: Twin,
): Promise<Comparison | null> {
  const { aiJson, INJECTION_RULES, untrusted } = await import("./ai-gateway.server");
  const { withAiSubject } = await import("../server/agents/context");
  const r = await withAiSubject({ requisitionId: twin.id }, () =>
    aiJson<Comparison>({
      system:
        INJECTION_RULES +
        "\nCompare two job descriptions' structured requirements and judge whether they describe the same " +
        "role. Treat skill equivalents as the same (e.g. 'B2B sales' and 'business development'); ignore " +
        "wording and order. Return ONLY JSON: similarity (0–1, 1 = the same role), must_have_overlap (0–1), " +
        "responsibility_themes (shared themes), field_diffs [{field, a, b}] for fields that differ, reasons " +
        "(short plain sentences).",
      prompt: `${untrusted("existing_role", JSON.stringify(twin.profile))}\n\n${untrusted("incoming_role", JSON.stringify(incoming))}`,
      orgId,
      feature: "jd_duplicate_check",
      schema: ComparisonSchema,
    }),
  );
  return r.ok ? r.data : null;
}

export type DuplicateOutcome = {
  verdict: Verdict;
  twinId: string | null;
  similarity: number;
  comparisons: number;
  comparison: {
    reasons: string[];
    fieldDiffs: { field: string; a?: string | null | undefined; b?: string | null | undefined }[];
    hardDifferences: string[];
    notCompared: boolean;
    jobCodeMatch: boolean;
  };
};

/**
 * The duplicate check, before anything is created (§4.3). A job code shared
 * with a live requisition proposes a duplicate with no AI call; closed
 * requisitions with that code are ordinary candidates. Hard differences are
 * decided in code and cap the verdict at variant whatever the model says.
 */
export async function checkDuplicate(
  orgId: string,
  incoming: RequirementProfile,
  opts: { budget: number; excludeIds?: string[] },
): Promise<DuplicateOutcome> {
  const settings = { ...DEFAULT_PROFILE_SETTINGS, ...(await workflowSettings(orgId)) };
  const coded = await jobCodeTwins(orgId, incoming.jobCode);
  const liveCode = coded.find((t) => t.live);
  if (liveCode) {
    return {
      verdict: "duplicate",
      twinId: liveCode.id,
      similarity: 1,
      comparisons: 0,
      comparison: {
        reasons: [`Same job code as ${liveCode.code}`],
        fieldDiffs: [],
        hardDifferences: hardDifferences(incoming, liveCode.profile, settings),
        notCompared: false,
        jobCodeMatch: true,
      },
    };
  }
  const narrowed = await narrowTwins(
    orgId,
    incoming,
    settings.jdDuplicateLookbackDays,
    opts.excludeIds,
  );
  const pool = [...coded.filter((c) => !narrowed.some((n) => n.id === c.id)), ...narrowed].slice(
    0,
    MAX_PAIRS_PER_JD,
  );
  let best: DuplicateOutcome = {
    verdict: "distinct",
    twinId: null,
    similarity: 0,
    comparisons: 0,
    comparison: {
      reasons: [],
      fieldDiffs: [],
      hardDifferences: [],
      notCompared: false,
      jobCodeMatch: false,
    },
  };
  let used = 0;
  for (const twin of pool) {
    const hard = hardDifferences(incoming, twin.profile, settings);
    let similarity: number;
    let reasons: string[];
    let fieldDiffs: DuplicateOutcome["comparison"]["fieldDiffs"] = [];
    let notCompared = false;
    if (used < opts.budget) {
      used += 1;
      const c = await compareProfiles(orgId, incoming, twin);
      if (c) {
        similarity = c.similarity;
        reasons = c.reasons ?? [];
        fieldDiffs = c.field_diffs ?? [];
      } else {
        similarity = titleSimilarity(incoming.title, twin.profile.title);
        reasons = ["Compared by title only"];
        notCompared = true;
      }
    } else {
      similarity = titleSimilarity(incoming.title, twin.profile.title);
      reasons = ["Compared by title only"];
      notCompared = true;
    }
    if (similarity > best.similarity) {
      best = {
        verdict: proposeVerdict(similarity, hard),
        twinId: twin.id,
        similarity,
        comparisons: 0,
        comparison: {
          reasons,
          fieldDiffs,
          hardDifferences: hard,
          notCompared,
          jobCodeMatch: coded.some((c) => c.id === twin.id),
        },
      };
    }
  }
  return { ...best, comparisons: used };
}

/* -------------------------------------------------- lightweight requisition */

/** Create the requisition and its JD from an extracted profile (§3.4). */
export async function createFromProfile(
  actor: LifecycleActor,
  profileId: string,
  text: string,
): Promise<{ requisitionId: string; code: string; autoApproved: boolean }> {
  const [row] = await db
    .select()
    .from(jdRequirementProfiles)
    .where(
      and(eq(jdRequirementProfiles.id, profileId), eq(jdRequirementProfiles.orgId, actor.orgId)),
    )
    .limit(1);
  if (!row) throw new Error("Requirement profile not found.");
  if (row.requisitionId) throw new Error("This JD already has a requisition.");
  const p = row.profile;

  const mode = (await workflowSettings(actor.orgId)).jdRequisitionMode ?? "approval_gate";
  let autoApprove: { policyAuditId: string } | undefined;
  if (mode === "auto_approved") {
    const policyAuditId = await autoApprovePolicyAuditId(actor.orgId);
    if (!policyAuditId)
      throw new Error("Auto-approval has no recorded authorisation. Ask HR to enable it again.");
    autoApprove = { policyAuditId };
  }

  const { createRequisitionCore, saveJobDescriptionCore } = await import("./requisitions.server");
  const location = [p.location.city, p.location.country].filter(Boolean).join(", ");
  const { id: requisitionId, code } = await createRequisitionCore(
    actor,
    {
      title: p.title,
      departmentId: null,
      location,
      openings: 1,
      experienceMin: Math.round(p.experienceYears?.min ?? 0),
      experienceMax: Math.round(p.experienceYears?.max ?? 0),
      budgetCtc: 0,
      ctcBandMin: null,
      ctcBandMax: null,
      maxNoticePeriodDays: null,
      workAuthorizationRequired: p.rightToWork,
      hiringManager: null,
      mustHaveSkills: p.mustHave,
      goodToHaveSkills: p.niceToHave,
      responsibilities: p.responsibilities.join("\n") || null,
      educationRequirement: null,
      billingType: "non_billable",
      engagementType: "internal",
      clientName: p.hiringClient,
      costCenter: null,
      workMode: p.location.remotePolicy === "unknown" ? null : p.location.remotePolicy,
    },
    "pending_dh",
    { autoApprove, externalJobCode: p.jobCode },
  );
  const jd = await saveJobDescriptionCore(
    actor,
    {
      requisitionId,
      jd: {
        purpose: "",
        responsibilities: p.responsibilities.join("\n"),
        must_have: p.mustHave,
        good_to_have: p.niceToHave,
        qualifications: "",
        success_factors: "",
        reporting_to: "",
        full_text: text,
      },
    },
    { autoApprove },
  );
  await db
    .update(jdRequirementProfiles)
    .set({ requisitionId, jobDescriptionId: jd.id })
    .where(
      and(eq(jdRequirementProfiles.id, profileId), eq(jdRequirementProfiles.orgId, actor.orgId)),
    );
  if (autoApprove)
    await writeAudit({
      actor: actor.memberEmail,
      actorUserId: actor.userId,
      orgId: actor.orgId,
      action: "requisition.auto_created",
      entityType: "requisition",
      entityId: requisitionId,
      detail: { code, policyAuditId: autoApprove.policyAuditId, via: "jd_import" },
    });
  return { requisitionId, code, autoApproved: Boolean(autoApprove) };
}

/**
 * Seed a variant's pipeline from its twin, once, additively (§4.3). Candidates
 * whose portal terms limit them to their original role ('role_only'), merged
 * records and closed-out applications are never copied.
 */
export async function seedFromTwin(
  orgId: string,
  fromRequisitionId: string,
  toRequisitionId: string,
): Promise<number> {
  await assertRequisitionInOrg(fromRequisitionId, orgId);
  await assertRequisitionInOrg(toRequisitionId, orgId);
  const rows = await db
    .select({ candidateId: applications.candidateId })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(
      and(
        eq(applications.orgId, orgId),
        eq(candidates.orgId, orgId),
        eq(applications.requisitionId, fromRequisitionId),
        ne(candidates.poolUse, "role_only"),
        isNull(candidates.mergedIntoId),
        notInArray(applications.stage, ["rejected", "offer_declined"]),
      ),
    );
  if (!rows.length) return 0;
  const inserted = await db
    .insert(applications)
    .values(
      rows.map((r) => ({
        orgId,
        requisitionId: toRequisitionId,
        candidateId: r.candidateId,
        stage: "sourced" as const,
        source: "seeded",
      })),
    )
    .onConflictDoNothing()
    .returning({ id: applications.id });
  return inserted.length;
}

/* --------------------------------------------------------- import items */

export type ImportFileResult =
  | { itemId: string; status: "created"; requisitionId: string; code: string }
  | { itemId: string; status: "review"; verdict: Verdict; matchRequisitionId: string }
  | { itemId: string; status: "error"; error: string };

/** One file of a bulk import: extract, check, then create or hold for review. */
export async function importJdFileCore(
  actor: LifecycleActor,
  input: { importId: string; fileName: string; text: string },
): Promise<ImportFileResult> {
  await assertImportRole(actor);
  const fileName = input.fileName.slice(0, 200);
  const fail = async (error: string): Promise<ImportFileResult> => {
    const [it] = await db
      .insert(jdImportItems)
      .values({
        orgId: actor.orgId,
        importId: input.importId,
        fileName,
        status: "error",
        error,
        createdBy: actor.userId,
      })
      .returning({ id: jdImportItems.id });
    return { itemId: it!.id, status: "error", error };
  };
  if (input.text.trim().length < 80) return fail("No readable text in this file.");

  const profile = await extractRequirementProfile(actor.orgId, input.text);
  if (!profile) return fail("The job description could not be read. Try again.");

  const [prof] = await db
    .insert(jdRequirementProfiles)
    .values({
      orgId: actor.orgId,
      profile,
      roleFamily: profile.roleFamily,
      sector: profile.sector,
    })
    .returning({ id: jdRequirementProfiles.id });

  const [{ used }] = (await db
    .select({ used: sql<number>`coalesce(sum(${jdImportItems.comparisons}), 0)::int` })
    .from(jdImportItems)
    .where(
      and(eq(jdImportItems.orgId, actor.orgId), eq(jdImportItems.importId, input.importId)),
    )) as [{ used: number }];
  const outcome = await checkDuplicate(actor.orgId, profile, {
    budget: Math.max(0, Math.min(MAX_PAIRS_PER_JD, MAX_PAIRS_PER_IMPORT - used)),
  });

  if (outcome.verdict === "distinct" || !outcome.twinId) {
    try {
      const made = await createFromProfile(actor, prof!.id, input.text);
      const [it] = await db
        .insert(jdImportItems)
        .values({
          orgId: actor.orgId,
          importId: input.importId,
          fileName,
          status: "created",
          profileId: prof!.id,
          requisitionId: made.requisitionId,
          proposedVerdict: "distinct",
          similarity: String(outcome.similarity.toFixed(3)),
          comparison: outcome.comparison,
          comparisons: outcome.comparisons,
          createdBy: actor.userId,
        })
        .returning({ id: jdImportItems.id });
      return {
        itemId: it!.id,
        status: "created",
        requisitionId: made.requisitionId,
        code: made.code,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Could not create the requisition.");
    }
  }

  const [it] = await db
    .insert(jdImportItems)
    .values({
      orgId: actor.orgId,
      importId: input.importId,
      fileName,
      status: "review",
      profileId: prof!.id,
      matchRequisitionId: outcome.twinId,
      proposedVerdict: outcome.verdict,
      similarity: String(outcome.similarity.toFixed(3)),
      comparison: { ...outcome.comparison, text: input.text.slice(0, MAX_JD_CHARS) },
      comparisons: outcome.comparisons,
      createdBy: actor.userId,
    })
    .returning({ id: jdImportItems.id });
  return {
    itemId: it!.id,
    status: "review",
    verdict: outcome.verdict,
    matchRequisitionId: outcome.twinId,
  };
}

/** The recruiter's decision on a held file (§4.4). Nothing is linked or created without it. */
export async function decideImportItemCore(
  actor: LifecycleActor,
  input: { itemId: string; verdict: Verdict },
): Promise<{ status: "linked" | "created"; requisitionId: string; seeded?: number | undefined }> {
  await assertImportRole(actor);
  // Claim the decision: only one reviewer wins a pending row.
  const [item] = await db
    .update(jdImportItems)
    .set({ decidedVerdict: input.verdict, decidedBy: actor.userId, decidedAt: new Date() })
    .where(
      and(
        eq(jdImportItems.id, input.itemId),
        eq(jdImportItems.orgId, actor.orgId),
        eq(jdImportItems.status, "review"),
        isNull(jdImportItems.decidedVerdict),
      ),
    )
    .returning();
  if (!item) throw new Error("That file has already been decided.");
  const release = () =>
    db
      .update(jdImportItems)
      .set({ decidedVerdict: null, decidedBy: null, decidedAt: null })
      .where(and(eq(jdImportItems.id, item.id), eq(jdImportItems.orgId, actor.orgId)));

  try {
    if (!item.matchRequisitionId || !item.profileId) throw new Error("Nothing to compare against.");
    await assertRequisitionInOrg(item.matchRequisitionId, actor.orgId);
    const text = String((item.comparison as { text?: string } | null)?.text ?? "");
    let result: {
      status: "linked" | "created";
      requisitionId: string;
      seeded?: number | undefined;
    };
    if (input.verdict === "duplicate") {
      await db
        .update(jdImportItems)
        .set({ status: "linked", requisitionId: item.matchRequisitionId })
        .where(and(eq(jdImportItems.id, item.id), eq(jdImportItems.orgId, actor.orgId)));
      result = { status: "linked", requisitionId: item.matchRequisitionId };
    } else {
      const made = await createFromProfile(actor, item.profileId, text);
      const seeded =
        input.verdict === "variant"
          ? await seedFromTwin(actor.orgId, item.matchRequisitionId, made.requisitionId)
          : undefined;
      await db
        .update(jdImportItems)
        .set({ status: "created", requisitionId: made.requisitionId })
        .where(and(eq(jdImportItems.id, item.id), eq(jdImportItems.orgId, actor.orgId)));
      result = { status: "created", requisitionId: made.requisitionId, seeded };
    }

    await writeAudit({
      actor: actor.memberEmail,
      actorUserId: actor.userId,
      orgId: actor.orgId,
      action: "jd_import.decided",
      entityType: "requisition",
      entityId: result.requisitionId,
      detail: {
        itemId: item.id,
        proposed: item.proposedVerdict,
        decided: input.verdict,
        matchRequisitionId: item.matchRequisitionId,
        seeded: result.seeded ?? null,
      },
    });
    // The recruiter's judgement on the AI proposal (consent-gated, never blocks).
    const { captureFeedback, latestInferenceFor } =
      await import("../server/training/capture.server");
    const inferenceId = await latestInferenceFor({
      orgId: actor.orgId,
      features: ["jd_duplicate_check"],
      requisitionId: item.matchRequisitionId,
    }).catch(() => null);
    void captureFeedback({
      orgId: actor.orgId,
      source: "jd_duplicate_review",
      label: input.verdict,
      original: {
        aiVerdict: item.proposedVerdict,
        similarity: item.similarity != null ? Number(item.similarity) : null,
        fieldDiffs: (item.comparison as { fieldDiffs?: unknown } | null)?.fieldDiffs ?? [],
      },
      corrected: { chosenAction: input.verdict },
      inferenceId,
      requisitionId: result.requisitionId,
      actorUserId: actor.userId,
    });
    return result;
  } catch (e) {
    await release();
    throw e;
  }
}

/**
 * Close an import session: pending reviews and their standalone profiles are
 * deleted (§4.5); created/linked rows and every requisition stay.
 */
export async function closeImportCore(
  actor: LifecycleActor,
  importId: string,
): Promise<{ removed: number }> {
  await assertImportRole(actor);
  const items = await db
    .select({ status: jdImportItems.status, profileId: jdImportItems.profileId })
    .from(jdImportItems)
    .where(and(eq(jdImportItems.orgId, actor.orgId), eq(jdImportItems.importId, importId)));
  const pending = items.filter((i) => i.status === "review" || i.status === "error");
  const profileIds = pending.map((i) => i.profileId).filter((x): x is string => Boolean(x));
  await db
    .delete(jdImportItems)
    .where(
      and(
        eq(jdImportItems.orgId, actor.orgId),
        eq(jdImportItems.importId, importId),
        inArray(jdImportItems.status, ["review", "error"]),
      ),
    );
  if (profileIds.length)
    await db
      .delete(jdRequirementProfiles)
      .where(
        and(
          eq(jdRequirementProfiles.orgId, actor.orgId),
          inArray(jdRequirementProfiles.id, profileIds),
          isNull(jdRequirementProfiles.requisitionId),
        ),
      );
  const count = (s: string) => items.filter((i) => i.status === s).length;
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "jd_import.bulk_completed",
    entityType: null,
    entityId: null,
    detail: {
      importId,
      created: count("created"),
      linked: count("linked"),
      dismissed: count("review"),
      failed: count("error"),
    },
  });
  return { removed: pending.length };
}

export type ImportItemView = {
  id: string;
  fileName: string;
  status: string;
  proposedVerdict: Verdict | null;
  decidedVerdict: Verdict | null;
  similarity: number | null;
  error: string | null;
  requisitionId: string | null;
  requisitionCode: string | null;
  match: { id: string; code: string; title: string; status: string } | null;
  reasons: string[];
  hardDifferences: string[];
  notCompared: boolean;
  jobCodeMatch: boolean;
  profile: RequirementProfile | null;
  matchProfile: RequirementProfile | null;
};

/** Every file of an import session, with both profiles for held reviews. */
export async function listImportCore(orgId: string, importId: string): Promise<ImportItemView[]> {
  const items = await db
    .select()
    .from(jdImportItems)
    .where(and(eq(jdImportItems.orgId, orgId), eq(jdImportItems.importId, importId)))
    .orderBy(jdImportItems.createdAt);
  const reqIds = [
    ...new Set(
      items
        .flatMap((i) => [i.requisitionId, i.matchRequisitionId])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const reqs = reqIds.length
    ? await db
        .select(reqCols)
        .from(requisitions)
        .where(and(eq(requisitions.orgId, orgId), inArray(requisitions.id, reqIds)))
    : [];
  const twins = new Map((await twinsFor(orgId, reqs)).map((t) => [t.id, t]));
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const profIds = items.map((i) => i.profileId).filter((x): x is string => Boolean(x));
  const profs = profIds.length
    ? await db
        .select({ id: jdRequirementProfiles.id, profile: jdRequirementProfiles.profile })
        .from(jdRequirementProfiles)
        .where(
          and(eq(jdRequirementProfiles.orgId, orgId), inArray(jdRequirementProfiles.id, profIds)),
        )
    : [];
  const profById = new Map(profs.map((p) => [p.id, p.profile]));
  return items.map((i) => {
    const c = (i.comparison ?? {}) as {
      reasons?: string[];
      hardDifferences?: string[];
      notCompared?: boolean;
      jobCodeMatch?: boolean;
    };
    const m = i.matchRequisitionId ? reqById.get(i.matchRequisitionId) : undefined;
    return {
      id: i.id,
      fileName: i.fileName,
      status: i.status,
      proposedVerdict: (i.proposedVerdict as Verdict | null) ?? null,
      decidedVerdict: (i.decidedVerdict as Verdict | null) ?? null,
      similarity: i.similarity != null ? Number(i.similarity) : null,
      error: i.error,
      requisitionId: i.requisitionId,
      requisitionCode: i.requisitionId ? (reqById.get(i.requisitionId)?.code ?? null) : null,
      match: m ? { id: m.id, code: m.code, title: m.title, status: m.status } : null,
      reasons: c.reasons ?? [],
      hardDifferences: c.hardDifferences ?? [],
      notCompared: Boolean(c.notCompared),
      jobCodeMatch: Boolean(c.jobCodeMatch),
      profile: i.profileId ? (profById.get(i.profileId) ?? null) : null,
      matchProfile: m ? (twins.get(m.id)?.profile ?? null) : null,
    };
  });
}
