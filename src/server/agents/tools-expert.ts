/**
 * Role expert interview agent tools: read what the role already states, and
 * propose the expert brief for the role's hiring manager to approve. The
 * interview itself is ask_human to the hiring manager (the runtime routes it
 * to the role's own hiring manager). Nothing here changes the role: the brief
 * and its interview-plan changes apply only when a person approves.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { jobDescriptions, orgMembers, requisitions } from "@db/schema";
import { ExpertBriefContent } from "@/lib/expert-brief";
import { db } from "../db";
import { assertRequisitionInOrg } from "../guards";
import { registerTool } from "./registry";

export function registerExpertTools(): void {
  registerTool({
    name: "read_role_for_expert",
    description:
      "What the role states today, to interview its expert from: title, level and location, must-haves and nice-to-haves, responsibilities, the latest job description's text, the interview plan's rounds and what each rates, the role's hiring manager (and whether they can sign in to answer), and the expert brief already approved, if any. Read it once, first.",
    input: z.object({ requisitionId: z.string().uuid() }),
    risk: "read",
    untrustedOutput: true,
    run: async (ctx, i) => {
      await assertRequisitionInOrg(i.requisitionId, ctx.orgId);
      const [r] = await db
        .select()
        .from(requisitions)
        .where(and(eq(requisitions.id, i.requisitionId), eq(requisitions.orgId, ctx.orgId)))
        .limit(1);
      if (!r) throw new Error("Requisition not found.");
      const [jd] = await db
        .select({ text: jobDescriptions.fullText, status: jobDescriptions.status })
        .from(jobDescriptions)
        .where(and(eq(jobDescriptions.requisitionId, r.id), eq(jobDescriptions.orgId, ctx.orgId)))
        .orderBy(desc(jobDescriptions.version))
        .limit(1);
      const [hm] = r.hiringManagerMemberId
        ? await db
            .select({
              name: orgMembers.fullName,
              email: orgMembers.email,
              userId: orgMembers.userId,
              status: orgMembers.status,
            })
            .from(orgMembers)
            .where(and(eq(orgMembers.id, r.hiringManagerMemberId), eq(orgMembers.orgId, ctx.orgId)))
            .limit(1)
        : [];
      const { planFor } = await import("@/lib/interview-plan.server");
      const { plan } = await planFor(ctx.orgId, r.id);
      return {
        code: r.code,
        title: r.title,
        status: r.status,
        location: r.location,
        workMode: r.workMode,
        experience: `${r.experienceMin}–${r.experienceMax} years`,
        mustHaveSkills: r.mustHaveSkills,
        goodToHaveSkills: r.goodToHaveSkills,
        responsibilities: r.responsibilities,
        jobDescription: jd
          ? { status: jd.status, text: String(jd.text ?? "").slice(0, 4000) }
          : null,
        interviewPlan: plan.rounds.map((x) => ({
          level: x.level,
          name: x.name,
          focus: x.focus,
          rates: x.competencies,
        })),
        hiringManager: hm
          ? {
              name: hm.name || hm.email,
              canAnswer: Boolean(hm.userId) && hm.status === "active",
            }
          : null,
        approvedBrief: r.expertBrief ?? null,
      };
    },
  });

  registerTool({
    name: "propose_expert_brief",
    description:
      "Propose the role's expert brief, written ONLY from what the hiring manager answered: must-haves with why each matters, nice-to-haves, deal-breakers, the first months' work, success after six months, 3–6 screening questions each with what a strong and a weak answer sound like, and for each interview round in the plan (by level) its focus and what it rates. The role's hiring manager approves it, sends it back with changes, or declines; on approval screening kits ask these questions and the rounds rate these areas.",
    input: z.object({
      requisitionId: z.string().uuid(),
      brief: ExpertBriefContent,
    }),
    risk: "write",
    describe: () => "The role expert brief",
    proposes: async (ctx, i) => {
      await assertRequisitionInOrg(i.requisitionId, ctx.orgId);
      return {
        title: "Is this what the role needs?",
        summary:
          "Written from the hiring manager's answers. Approving makes it the brief screening and interviews work from.",
        subject: { type: "expert_brief", requisitionId: i.requisitionId, brief: i.brief },
      };
    },
    run: async () => {
      throw new Error("An expert brief is decided by a person.");
    },
  });
}
