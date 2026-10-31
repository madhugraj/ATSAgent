/**
 * Tools of the silent panel agents L1 / L2 / L3 (docs/silent-panel-agent-plan.md,
 * S2). Each checks that the round is the calling agent's own level, and none
 * returns the transcript or the agent's score — counts and facts only — so the
 * hidden view cannot reach an approval card, a run log or the panel early.
 */
import { z } from "zod";

import { registerTool, type ToolContext } from "./registry";

const RoundId = z.object({ interviewId: z.string().uuid() });

async function levelFor(ctx: ToolContext) {
  const { levelOfAgent } = await import("../panel/assess.server");
  const level = levelOfAgent(ctx.agentType);
  if (!level) throw new Error("Only the L1, L2 and L3 panel agents use this tool.");
  return level;
}

export function registerPanelTools(): void {
  registerTool({
    name: "get_round_for_panel",
    description:
      "Facts about an interview round this agent reads: the candidate, role, round and its competencies, how many are on the panel, whether the call's transcript is in, and whether it is already assessed and summarised. Never the transcript itself or any score.",
    input: RoundId,
    risk: "read",
    run: async (ctx, i) => {
      const { roundFacts } = await import("../panel/assess.server");
      return roundFacts(ctx.orgId, i.interviewId, await levelFor(ctx));
    },
  });

  registerTool({
    name: "assess_round",
    description:
      "Read the round's call transcript and record this agent's own view of the candidate (rating, verdict, per-competency notes with quoted evidence) and of the panel (competencies covered, talk time, questions on protected ground). The view is stored hidden until the panel has scored; this returns only counts.",
    input: RoundId,
    risk: "write",
    skills: ["panel_assess"],
    describe: () => "Assess the interview call (kept hidden until the panel has scored)",
    precheck: async (ctx, i) => {
      const { assessPrecheck } = await import("../panel/assess.server");
      return assessPrecheck(ctx.orgId, i.interviewId, await levelFor(ctx));
    },
    run: async (ctx, i) => {
      const { assessRound } = await import("../panel/assess.server");
      return assessRound(
        { orgId: ctx.orgId, runId: ctx.runId },
        i.interviewId,
        await levelFor(ctx),
      );
    },
  });

  registerTool({
    name: "send_panel_summary",
    description:
      "E-mail everyone on the round's panel a factual summary of the call — what was asked and how the candidate answered — with no score, verdict or recommendation. Once per round.",
    input: RoundId,
    risk: "external",
    skills: ["panel_summary"],
    templateOf: () => "panel_summary",
    describe: () => "E-mail the panel a factual summary of the call",
    precheck: async (ctx, i) => {
      const { summaryPrecheck } = await import("../panel/assess.server");
      return summaryPrecheck(ctx.orgId, i.interviewId, await levelFor(ctx));
    },
    run: async (ctx, i) => {
      const { sendPanelSummary } = await import("../panel/assess.server");
      return sendPanelSummary(
        { orgId: ctx.orgId, runId: ctx.runId },
        i.interviewId,
        await levelFor(ctx),
      );
    },
  });
}
