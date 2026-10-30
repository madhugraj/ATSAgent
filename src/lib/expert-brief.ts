/**
 * A role's expert brief (client-safe): what the role's hiring manager — the
 * person who knows the work — said the role really needs, captured by the
 * Role expert interview agent and approved by that same person. Stored on
 * the requisition (`expert_brief`, migration 0057) and read by the screening
 * kit (its must-ask questions and deal-breakers) and the interview plan (each
 * round's focus and what it rates).
 */
import { z } from "zod";

const line = (max: number) => z.string().trim().min(2).max(max);

export const ExpertBriefContent = z.object({
  /** Must-haves in the expert's own terms, each with why it matters for this team. */
  mustHaves: z
    .array(z.object({ skill: line(80), why: line(300) }))
    .min(1)
    .max(10),
  niceToHaves: z.array(line(80)).max(10).default([]),
  /** What rules a candidate out, whatever else they bring. */
  dealBreakers: z.array(line(200)).max(8).default([]),
  /** What the first months' work is, and what good looks like after six months. */
  firstMonthsWork: line(800),
  successAfterSixMonths: line(600),
  /** Questions every screening should ask, with what a strong and a weak answer sound like. */
  screeningQuestions: z
    .array(z.object({ question: line(300), strongAnswer: line(400), weakAnswer: line(400) }))
    .min(1)
    .max(6),
  /** Per interview round: what it should focus on and rate (applied to the plan on approval). */
  rounds: z
    .array(
      z.object({
        level: z.number().int().min(1).max(3),
        focus: z.string().trim().max(300),
        competencies: z.array(line(60)).min(1).max(8),
      }),
    )
    .max(3)
    .default([]),
});
export type ExpertBriefContent = z.infer<typeof ExpertBriefContent>;

/** As stored on the requisition once the hiring manager approved it. */
export type ExpertBrief = ExpertBriefContent & {
  approvedBy: string;
  approvedAt: string;
  /** The expert who was interviewed (an org member). */
  expertMemberId: string | null;
};
