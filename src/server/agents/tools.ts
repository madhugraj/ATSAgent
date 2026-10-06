/**
 * Phase 1 agent tools (docs/agentic-plan.md §3.4): thin wrappers over the
 * requisition / JD / publishing cores. Every tool runs as the run's human
 * principal (`actorFor`), so role checks and org predicates are exactly those
 * of the person; writes are recorded with `via: "agent"` in approval trails.
 *
 * Gate actions (approving, releasing, rejecting) are not tools — agents ask
 * for them with request_approval (registry gate guard).
 */
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod/v4";

import { db } from "../db";
import { departments, jobDescriptions, requisitions } from "@db/schema";
import { registerTool, type ToolContext } from "./registry";

const actor = async (ctx: ToolContext) => {
  const { actorFor } = await import("@/lib/requisitions.server");
  return actorFor(ctx.orgId, ctx.principalUserId);
};

const num = (v: unknown) => (v == null ? null : Number(v));

async function loadRequisition(orgId: string, id: string) {
  const [r] = await db
    .select()
    .from(requisitions)
    .where(and(eq(requisitions.id, id), eq(requisitions.orgId, orgId)))
    .limit(1);
  if (!r) throw new Error("Requisition not found.");
  return r;
}

function requisitionView(r: typeof requisitions.$inferSelect) {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    status: r.status,
    departmentId: r.departmentId,
    location: r.location,
    openings: r.openings,
    experienceMin: r.experienceMin,
    experienceMax: r.experienceMax,
    budgetCtc: num(r.budgetCtc),
    ctcBandMin: num(r.ctcBandMin),
    ctcBandMax: num(r.ctcBandMax),
    mustHaveSkills: r.mustHaveSkills,
    goodToHaveSkills: r.goodToHaveSkills,
    responsibilities: r.responsibilities,
    educationRequirement: r.educationRequirement,
    hiringManager: r.hiringManager,
    ijpEnabled: r.ijpEnabled,
    weights: {
      skills: r.weightSkills,
      experience: r.weightExperience,
      career: r.weightCareer,
      impact: r.weightImpact,
      education: r.weightEducation,
      social: r.weightSocial,
    },
  };
}

const RequisitionId = z.object({ requisitionId: z.string().uuid() });

const DraftFields = z.object({
  title: z.string().min(2).max(200),
  departmentId: z.string().uuid().nullable().optional(),
  location: z.string().max(200).default(""),
  openings: z.number().int().min(1).max(500).default(1),
  experienceMin: z.number().int().min(0).max(50).default(0),
  experienceMax: z.number().int().min(0).max(60).default(0),
  mustHaveSkills: z.array(z.string().max(80)).max(30).default([]),
  goodToHaveSkills: z.array(z.string().max(80)).max(30).default([]),
  responsibilities: z.string().max(6000).nullable().optional(),
  educationRequirement: z.string().max(1000).nullable().optional(),
  hiringManager: z.string().max(200).nullable().optional(),
});

export function registerPhase1Tools(): void {
  /* ------------------------------------------------------------- reads */

  registerTool({
    name: "list_departments",
    description: "List this organisation's departments (id and name).",
    input: z.object({}),
    risk: "read",
    run: async (ctx) =>
      db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(eq(departments.orgId, ctx.orgId))
        .orderBy(departments.name),
  });

  registerTool({
    name: "list_requisitions",
    description: "List the organisation's 25 most recent requisitions with code, title and status.",
    input: z.object({}),
    risk: "read",
    run: async (ctx) =>
      db
        .select({
          id: requisitions.id,
          code: requisitions.code,
          title: requisitions.title,
          status: requisitions.status,
          location: requisitions.location,
        })
        .from(requisitions)
        .where(eq(requisitions.orgId, ctx.orgId))
        .orderBy(desc(requisitions.createdAt))
        .limit(25),
  });

  registerTool({
    name: "find_similar_requisitions",
    description:
      "Find earlier requisitions with a similar title, to reuse skills, experience and pay bands and to avoid duplicates.",
    input: z.object({ title: z.string().min(2).max(200) }),
    risk: "read",
    run: async (ctx, i) => {
      const words = i.title
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}+#.-]/gu, ""))
        .filter((w) => w.length >= 3)
        .slice(0, 5);
      if (!words.length) return [];
      const rows = await db
        .select()
        .from(requisitions)
        .where(
          and(
            eq(requisitions.orgId, ctx.orgId),
            or(...words.map((w) => ilike(requisitions.title, `%${w}%`))),
          ),
        )
        .orderBy(desc(requisitions.createdAt))
        .limit(5);
      return rows.map(requisitionView);
    },
  });

  registerTool({
    name: "get_requisition",
    description:
      "Read one requisition (fields, status, scoring weights) and its latest job-description version.",
    input: RequisitionId,
    risk: "read",
    run: async (ctx, i) => {
      const r = await loadRequisition(ctx.orgId, i.requisitionId);
      const [jd] = await db
        .select({
          id: jobDescriptions.id,
          version: jobDescriptions.version,
          status: jobDescriptions.status,
          approverComment: jobDescriptions.approverComment,
        })
        .from(jobDescriptions)
        .where(and(eq(jobDescriptions.requisitionId, r.id), eq(jobDescriptions.orgId, ctx.orgId)))
        .orderBy(desc(jobDescriptions.version))
        .limit(1);
      return { ...requisitionView(r), latestJd: jd ?? null };
    },
  });

  registerTool({
    name: "research_compensation",
    description:
      "Live market pay research for the requisition's role, location and experience, with cited sources and a recommended budget and band. Slow; call once per requisition.",
    input: RequisitionId.extend({ currency: z.string().length(3).default("INR") }),
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      const r = await loadRequisition(ctx.orgId, i.requisitionId);
      const { benchmarkMarket } = await import("@/lib/market.server");
      const b = await benchmarkMarket({
        orgId: ctx.orgId,
        role: r.title,
        location: r.location || "India",
        currency: i.currency,
        experienceMin: r.experienceMin,
        experienceMax: r.experienceMax,
        skills: r.mustHaveSkills,
      });
      return {
        currency: b.currency,
        recommended: b.recommended,
        levels: b.levels,
        caveats: b.caveats,
        sources: b.sources.slice(0, 8),
        inHouseDecisions: b.in_house.length,
      };
    },
  });

  registerTool({
    name: "suggest_weights",
    description:
      "Suggest how the 100 candidate-scoring points should be split across skills, experience, career, impact, education and social for this requisition.",
    input: RequisitionId,
    risk: "read",
    run: async (ctx, i) => {
      const r = await loadRequisition(ctx.orgId, i.requisitionId);
      const { suggestWeightsCore } = await import("@/lib/matching.functions");
      return suggestWeightsCore(ctx.orgId, {
        title: r.title,
        mustHave: r.mustHaveSkills,
        goodToHave: r.goodToHaveSkills,
        education: r.educationRequirement,
        experienceMin: r.experienceMin,
        experienceMax: r.experienceMax,
        jdText: r.responsibilities,
      });
    },
  });

  registerTool({
    name: "draft_linkedin_post",
    description: "Draft a LinkedIn hiring post for an approved requisition from its approved JD.",
    input: RequisitionId.extend({
      tone: z.enum(["professional", "warm", "bold"]).default("professional"),
    }),
    risk: "read",
    run: async (ctx, i) => {
      const r = await loadRequisition(ctx.orgId, i.requisitionId);
      const [jd] = await db
        .select({ fullText: jobDescriptions.fullText })
        .from(jobDescriptions)
        .where(
          and(
            eq(jobDescriptions.requisitionId, r.id),
            eq(jobDescriptions.orgId, ctx.orgId),
            eq(jobDescriptions.status, "approved"),
          ),
        )
        .orderBy(desc(jobDescriptions.version))
        .limit(1);
      const { draftLinkedinPostCore } = await import("@/lib/matching.functions");
      return draftLinkedinPostCore(ctx.orgId, {
        title: r.title,
        company: "",
        location: r.location,
        openings: r.openings,
        experienceMin: r.experienceMin,
        experienceMax: r.experienceMax,
        mustHave: r.mustHaveSkills,
        goodToHave: r.goodToHaveSkills,
        jdText: jd?.fullText ?? r.responsibilities,
        tone: i.tone,
      });
    },
  });

  /* ------------------------------------------------------------ writes */

  registerTool({
    name: "draft_requisition",
    description:
      "Create a new requisition as a DRAFT (not yet submitted). Returns its id and code.",
    input: DraftFields,
    risk: "write",
    describe: (i) => `Create draft requisition "${i.title}" (${i.openings} opening(s))`,
    run: async (ctx, i) => {
      const { createRequisitionCore } = await import("@/lib/requisitions.server");
      return createRequisitionCore(
        await actor(ctx),
        {
          title: i.title,
          departmentId: i.departmentId ?? null,
          location: i.location,
          openings: i.openings,
          experienceMin: i.experienceMin,
          experienceMax: i.experienceMax,
          budgetCtc: 0,
          ctcBandMin: null,
          ctcBandMax: null,
          maxNoticePeriodDays: null,
          workAuthorizationRequired: null,
          hiringManager: i.hiringManager ?? null,
          mustHaveSkills: i.mustHaveSkills,
          goodToHaveSkills: i.goodToHaveSkills,
          responsibilities: i.responsibilities ?? null,
          educationRequirement: i.educationRequirement ?? null,
          billingType: "Non-billable",
          engagementType: "Internal / Corporate",
          clientName: null,
          costCenter: null,
        },
        "draft",
      );
    },
  });

  registerTool({
    name: "update_requisition_draft",
    description:
      "Change fields of a requisition that is still a draft (or was rejected / put on hold).",
    input: RequisitionId.extend({ changes: DraftFields.partial() }),
    risk: "write",
    describe: (i) => `Update draft requisition (${Object.keys(i.changes).join(", ")})`,
    run: async (ctx, i) => {
      const { updateRequisitionDraftCore } = await import("@/lib/requisitions.server");
      const c = i.changes;
      await updateRequisitionDraftCore(await actor(ctx), i.requisitionId, {
        ...c,
        departmentId: c.departmentId ?? undefined,
        responsibilities: c.responsibilities ?? undefined,
        educationRequirement: c.educationRequirement ?? undefined,
        hiringManager: c.hiringManager ?? undefined,
      });
      return { ok: true };
    },
  });

  registerTool({
    name: "set_compensation",
    description: "Set the requisition's budget CTC and pay band (annual, in the org currency).",
    input: RequisitionId.extend({
      budgetCtc: z.number().positive(),
      bandMin: z.number().positive(),
      bandMax: z.number().positive(),
    }),
    risk: "write",
    describe: (i) =>
      `Set budget ${i.budgetCtc.toLocaleString()} (band ${i.bandMin.toLocaleString()}–${i.bandMax.toLocaleString()})`,
    run: async (ctx, i) => {
      if (i.bandMin > i.bandMax) throw new Error("bandMin must not exceed bandMax.");
      const { updateRequisitionCompensationCore } = await import("@/lib/requisitions.server");
      await updateRequisitionCompensationCore(await actor(ctx), {
        id: i.requisitionId,
        budgetCtc: i.budgetCtc,
        ctcBandMin: i.bandMin,
        ctcBandMax: i.bandMax,
      });
      return { ok: true };
    },
  });

  registerTool({
    name: "save_weights",
    description: "Save the six candidate-scoring weights (integers that sum to 100).",
    input: RequisitionId.extend({
      skills: z.number().int().min(0).max(100),
      experience: z.number().int().min(0).max(100),
      career: z.number().int().min(0).max(100),
      impact: z.number().int().min(0).max(100),
      education: z.number().int().min(0).max(100),
      social: z.number().int().min(0).max(100),
    }),
    risk: "write",
    describe: () => "Save candidate-scoring weights",
    run: async (ctx, i) => {
      const { requisitionId, ...w } = i;
      const total = Object.values(w).reduce((s, v) => s + v, 0);
      if (total !== 100) throw new Error(`Weights must sum to 100 (got ${total}).`);
      const { saveRequisitionWeightsCore } = await import("@/lib/requisitions.server");
      await saveRequisitionWeightsCore(await actor(ctx), requisitionId, w);
      return { ok: true };
    },
  });

  registerTool({
    name: "submit_requisition_for_approval",
    description:
      "Send a complete draft requisition into the approval chain (Department Head → HR head → CBO).",
    input: RequisitionId,
    risk: "write",
    describe: () => "Submit the requisition for Department Head approval",
    run: async (ctx, i) => {
      const { advanceRequisitionCore } = await import("@/lib/requisitions.server");
      await advanceRequisitionCore(await actor(ctx), {
        id: i.requisitionId,
        status: "pending_dh",
        comment: "Submitted by the requisition agent.",
      });
      return { ok: true, status: "pending_dh" };
    },
  });

  registerTool({
    name: "submit_jd_version",
    description:
      "Draft the job description for the requisition with the organisation's JD template and file it as the next version for Department Head review. Pass revisionNotes to address reviewer feedback.",
    input: RequisitionId.extend({ revisionNotes: z.string().max(4000).optional() }),
    risk: "write",
    describe: (i) =>
      i.revisionNotes
        ? "Revise and resubmit the job description"
        : "Draft and submit the job description",
    run: async (ctx, i) => {
      const r = await loadRequisition(ctx.orgId, i.requisitionId);
      if (!["approved", "pending_dh", "pending_hr", "pending_cbo"].includes(r.status)) {
        throw new Error(
          `The requisition is ${r.status}; JDs are drafted for submitted or approved requisitions.`,
        );
      }
      const [dept] = r.departmentId
        ? await db
            .select({ name: departments.name })
            .from(departments)
            .where(and(eq(departments.id, r.departmentId), eq(departments.orgId, ctx.orgId)))
            .limit(1)
        : [];
      const { generateJdCore } = await import("@/lib/matching.functions");
      const jd = await generateJdCore(ctx.orgId, {
        title: r.title,
        department: dept?.name ?? null,
        location: r.location,
        experienceMin: r.experienceMin,
        experienceMax: r.experienceMax,
        mustHave: r.mustHaveSkills,
        goodToHave: r.goodToHaveSkills,
        responsibilities: [
          r.responsibilities,
          i.revisionNotes ? `Reviewer feedback to address: ${i.revisionNotes}` : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
        education: r.educationRequirement,
        reportingTo: r.hiringManager,
      });
      const { saveJobDescriptionCore } = await import("@/lib/requisitions.server");
      const saved = await saveJobDescriptionCore(await actor(ctx), { requisitionId: r.id, jd });
      return {
        jdId: saved.id,
        version: saved.version,
        purpose: jd.purpose,
        mustHave: jd.must_have,
      };
    },
  });

  registerTool({
    name: "enable_internal_posting",
    description: "Open an approved requisition to employees on the internal job board (IJP).",
    input: RequisitionId,
    risk: "write",
    describe: () => "Post the requisition on the internal job board",
    run: async (ctx, i) => {
      const r = await loadRequisition(ctx.orgId, i.requisitionId);
      if (r.status !== "approved") throw new Error("Only approved requisitions can be posted.");
      const { setRequisitionIjpCore } = await import("@/lib/requisitions.server");
      await setRequisitionIjpCore(await actor(ctx), r.id, true);
      return { ok: true };
    },
  });

  registerTool({
    name: "publish_to_job_board",
    description:
      "Publish an approved requisition on a connected job board (LinkedIn, Indeed or Naukri). Always reviewed by a person first; the person the agent works for must be an HR head.",
    input: RequisitionId.extend({
      provider: z.enum(["linkedin", "indeed", "naukri"]),
      postText: z.string().max(3000).optional(),
    }),
    risk: "external",
    describe: (i) => `Publish the requisition on ${i.provider}`,
    run: async (ctx, i) => {
      const { assertRole } = await import("@/lib/auth.middleware");
      await assertRole(ctx.principalUserId, ctx.orgId, "hr_head");
      const a = await actor(ctx);
      const { publishToBoardImpl } = await import("../boards/publish.server");
      return publishToBoardImpl({
        orgId: ctx.orgId,
        actor: { memberEmail: a.memberEmail, userId: a.userId },
        requisitionId: i.requisitionId,
        provider: i.provider,
        postText: i.postText?.trim() || null,
      });
    },
  });

  /* ----------------------------------------------------------- copilot */

  registerTool({
    name: "start_agent",
    description:
      "Hand a piece of work to a specialist agent: requisition (draft and submit a new role), jd (draft or revise a JD for an existing requisition) or publishing (post an approved role). The person confirms before it starts.",
    input: z.object({
      agent: z.enum(["requisition", "jd", "publishing"]),
      goal: z.string().min(10).max(2000),
      requisitionId: z.string().uuid().optional(),
    }),
    risk: "write",
    describe: (i) => `Start the ${i.agent} agent: ${i.goal.slice(0, 120)}`,
    run: async (ctx, i) => {
      if (i.agent !== "requisition" && !i.requisitionId) {
        throw new Error("The jd and publishing agents need a requisitionId.");
      }
      if (i.requisitionId) await loadRequisition(ctx.orgId, i.requisitionId);
      const { startRun } = await import("./runtime.server");
      const { runId } = await startRun({
        orgId: ctx.orgId,
        agentType: i.agent,
        principalUserId: ctx.principalUserId,
        goal: i.requisitionId ? `${i.goal}\n\nRequisition id: ${i.requisitionId}` : i.goal,
        subjectType: i.requisitionId ? "requisition" : null,
        subjectId: i.requisitionId ?? null,
      });
      return { started: i.agent, runId };
    },
  });
}

/** Requisitions the orchestrator should not double-dispatch (active runs). */
export async function activeRunFor(
  orgId: string,
  agentType: string,
  requisitionId: string,
): Promise<boolean> {
  const { agentRuns } = await import("@db/schema");
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentType, agentType as never),
        eq(agentRuns.subjectId, requisitionId),
        inArray(agentRuns.status, ["queued", "running", "awaiting_human"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}
