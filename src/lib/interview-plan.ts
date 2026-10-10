/**
 * A role's interview plan (client-safe): how many rounds, what each round is
 * for, the competencies interviewers rate (built from the role's must-haves so
 * scores line up across interviewers), how many people sit on each panel, and
 * what an interviewer's verdict does.
 *
 * verdictPolicy:
 * - "recommend" (default): a round advances only when every panel member
 *   selects; a hold or reject is a recommendation the hiring manager decides.
 * - "immediate": the round's verdict moves the candidate at once (the
 *   earlier behaviour) — select only when everyone selects, otherwise the
 *   most cautious verdict (reject over hold).
 * The hiring decision itself (select → offer) always comes after the final
 * round, from the hiring manager.
 */
import { z } from "zod";

export const PlanRound = z.object({
  level: z.number().int().min(1).max(3),
  name: z.string().trim().min(2).max(60),
  focus: z.string().trim().max(300).default(""),
  competencies: z.array(z.string().trim().min(2).max(60)).min(1).max(8),
  panelSize: z.number().int().min(1).max(3).default(1),
});

export const InterviewPlanSchema = z
  .object({
    rounds: z.array(PlanRound).min(1).max(3),
    verdictPolicy: z.enum(["recommend", "immediate"]).default("recommend"),
  })
  .refine((p) => p.rounds.every((r, i) => r.level === i + 1), {
    message: "Rounds must be numbered 1, 2, 3 in order.",
  });

export type InterviewPlan = z.infer<typeof InterviewPlanSchema>;
export type PlanRoundT = z.infer<typeof PlanRound>;

const uniq = (xs: string[]) =>
  xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);

/** The default plan for a role: rounds and rubric from its own must-haves. */
export function defaultPlan(mustHave: string[] | null | undefined): InterviewPlan {
  const skills = uniq((mustHave ?? []).map((s) => s.trim()).filter((s) => s.length >= 2));
  const first = skills.slice(0, 4);
  const rest = skills.slice(4, 7);
  return {
    verdictPolicy: "recommend",
    rounds: [
      {
        level: 1,
        name: "Skills",
        focus: first.length
          ? `Depth in ${first.join(", ")} — ask for real work they did, not definitions.`
          : "Core skills for the role — ask for real work they did.",
        competencies: uniq([...first, "Problem solving"]).slice(0, 6),
        panelSize: 1,
      },
      {
        level: 2,
        name: "Role and ownership",
        focus: rest.length
          ? `${rest.join(", ")}, and how they own outcomes and work with others.`
          : "How they own outcomes, handle trade-offs and work with others.",
        competencies: uniq([...rest, "Ownership", "Collaboration", "Communication"]).slice(0, 6),
        panelSize: 1,
      },
      {
        level: 3,
        name: "Fit and growth",
        focus: "Judgement, motivation and how they will grow in the team.",
        competencies: ["Judgement", "Motivation", "Growth potential", "Team fit"],
        panelSize: 1,
      },
    ],
  };
}

export function finalLevel(plan: InterviewPlan): number {
  return plan.rounds.length;
}

export function roundOf(plan: InterviewPlan, level: number): PlanRoundT | null {
  return plan.rounds.find((r) => r.level === level) ?? null;
}

export type Verdict = "select" | "hold" | "reject";

/** The round's combined verdict: select only if everyone selects; else the most cautious. */
export function roundVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("reject")) return "reject";
  if (verdicts.includes("hold")) return "hold";
  return "select";
}
