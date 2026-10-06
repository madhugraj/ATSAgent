/**
 * Human-in-the-loop tools every agent has (docs/agentic-plan.md §5): ask a
 * person, request a human decision, hand off. Part of every manifest hash.
 */
import { z } from "zod/v4";

const ROLES = [
  "recruiter",
  "hiring_manager",
  "department_head",
  "hr_head",
  "president_cbo",
] as const;

export const HITL_TOOLS = {
  ask_human: {
    description:
      "Ask a person a clarifying question when you cannot proceed safely without their answer. The run pauses until they reply.",
    input: z.object({
      question: z.string().min(1).max(2000),
      assignee_role: z.enum(ROLES).optional(),
    }),
  },
  request_approval: {
    description:
      "Ask the responsible approver for a decision that only a person may make (requisition, JD or offer approval, offer release, rejection, hiring decision). Explain what you prepared and why. The run pauses until they decide.",
    input: z.object({
      title: z.string().min(1).max(200),
      summary: z.string().min(1).max(4000),
      assignee_role: z.enum(ROLES),
      subject: z
        .union([
          z.object({ type: z.enum(["requisition", "jd"]), id: z.string().uuid() }),
          z.object({
            type: z.literal("hiring_decision"),
            applicationId: z.string().uuid(),
            recommendation: z.enum(["select", "hold", "reject"]),
            rationale: z.string().min(10).max(2000),
          }),
          z.object({
            type: z.literal("rejection"),
            items: z
              .array(
                z.object({
                  applicationId: z.string().uuid(),
                  reason: z.string().min(3).max(500),
                }),
              )
              .min(1)
              .max(50),
          }),
        ])
        .optional()
        .describe(
          "What the approval is for. A requisition or JD version: approving or declining in the inbox performs the real approval step, and the approver role comes from where the item is in its chain. A rejection batch: the listed candidates are rejected with their reasons only if the person approves.",
        ),
    }),
  },
  handoff: {
    description:
      "Stop and hand the work back to a person when the task is outside what you can do. Give the reason.",
    input: z.object({ reason: z.string().min(1).max(2000) }),
  },
} as const;
export type HitlName = keyof typeof HITL_TOOLS;
export const isHitl = (name: string): name is HitlName => name in HITL_TOOLS;
