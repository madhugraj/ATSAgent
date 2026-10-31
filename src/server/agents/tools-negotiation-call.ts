/**
 * Negotiation call tools (docs/negotiator-voice-agent.md, step N3).
 *
 * - request_negotiation_call: the Offer agent asks for an AI pay call, with the
 *   one improved figure it would offer (or none, to hold). Never pre-approved:
 *   the HR head approves every one (and may change the figure); every rule is
 *   checked by the system.
 * - The Negotiation call agent's in-call tools: the same contracts the live
 *   call uses (src/server/voice/negotiation-call-tools.ts), here applied in
 *   text mode (evals) to the in-progress negotiation call the run belongs to.
 *   The call state of a text-mode run lives in memory; what was heard is
 *   written the same way as on a live call.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { offerNegotiations, screeningCalls } from "@db/schema";
import { rupees } from "@/lib/money";
import { db } from "../db";
import {
  applyNegotiationTool,
  freshNegotiationState,
  NEGOTIATION_TOOL_DESCRIPTIONS,
  NEGOTIATION_TOOL_INPUTS,
  NEGOTIATION_TOOL_NAMES,
  negotiationOutcome,
  type NegotiationCallState,
  type NegotiationEndReason,
  type NegotiationToolName,
} from "../voice/negotiation-call-tools";
import { registerTool, type ToolContext } from "./registry";

/** The negotiation call this run is working on: its own, or (text mode) the org's unclaimed one. */
async function callForRun(ctx: ToolContext) {
  const [own] = await db
    .select()
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, ctx.orgId),
        eq(screeningCalls.agentRunId, ctx.runId),
        eq(screeningCalls.purpose, "negotiation"),
      ),
    )
    .limit(1);
  if (own) return own;
  const [free] = await db
    .select()
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, ctx.orgId),
        eq(screeningCalls.purpose, "negotiation"),
        eq(screeningCalls.status, "in_progress"),
        isNull(screeningCalls.agentRunId),
      ),
    )
    .orderBy(desc(screeningCalls.updatedAt))
    .limit(1);
  if (!free) throw new Error("There is no pay call in progress for this run.");
  await db
    .update(screeningCalls)
    .set({ agentRunId: ctx.runId, updatedAt: new Date() })
    .where(eq(screeningCalls.id, free.id));
  return { ...free, agentRunId: ctx.runId };
}

/** Text-mode call state per run (a live call keeps its own in the session). */
const textState = new Map<string, NegotiationCallState>();

async function applyToCall(ctx: ToolContext, name: NegotiationToolName, input: unknown) {
  const call = await callForRun(ctx);
  const { loadNegotiationBrief } = await import("../voice/negotiation-brief.server");
  const brief = await loadNegotiationBrief(ctx.orgId, call.id);
  if (!brief) throw new Error("This call's pay discussion was not found.");
  let state = textState.get(ctx.runId);
  if (!state) {
    state = {
      ...freshNegotiationState(),
      permission: call.consentAt ? true : call.consentWords ? false : null,
    };
    textState.set(ctx.runId, state);
  }
  const out = applyNegotiationTool(state, name, input, brief.figures);
  if (!out.ok) throw new Error(out.error);
  if (name === "record_permission")
    await db
      .update(screeningCalls)
      .set({
        consentAt: state.permission ? (call.consentAt ?? new Date()) : null,
        consentWords: state.permissionWords ?? null,
        updatedAt: new Date(),
      })
      .where(eq(screeningCalls.id, call.id));
  if (name === "end_negotiation_call") {
    const { callOutcomeOf } = await import("../voice/negotiation-session.server");
    const heard = callOutcomeOf(call.id, state, new Date());
    if (heard)
      await db
        .update(offerNegotiations)
        .set({ callOutcome: heard, updatedAt: new Date() })
        .where(
          and(
            eq(offerNegotiations.id, brief.negotiationId),
            eq(offerNegotiations.orgId, ctx.orgId),
          ),
        );
    await db
      .update(screeningCalls)
      .set({
        status: "completed",
        endReason: (input as { reason: NegotiationEndReason }).reason,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(screeningCalls.id, call.id));
    if ((input as { reason: NegotiationEndReason }).reason === "opt_out") {
      const { recordAiCallOptOut } = await import("../voice/opt-out.server");
      await recordAiCallOptOut({
        orgId: ctx.orgId,
        candidateId: call.candidateId,
        source: "call",
        actor: ctx.actor,
        callId: call.id,
      });
    }
    textState.delete(ctx.runId);
    return { ok: true, outcome: negotiationOutcome(state) };
  }
  return out;
}

export function registerNegotiationCallTools(): void {
  registerTool({
    name: "request_negotiation_call",
    description:
      "Ask for an AI pay call to the candidate of an unsettled pay discussion (they countered, asked for a call, or did not answer the message): the assistant phones them inside the calling window, wins their interest, reads out the proposal and its levers, explains the package from `brief` (the fixed / variable split adding up to the proposal, ESOPs, how the review works, benefits, how the figure was set (rationale: level, internal parity, market benchmark — in words), and up to three reasons why the team wants them — from the hiring decision and interview notes, in words, no amounts in the words), and may offer improvedCtc ONCE if they turn it down and say they would go ahead if it improved — one figure above the proposal and at or under the approved ceiling, or null to hold at the proposal. It never agrees anything: a yes goes to TA / the HR head to confirm. The HR head always approves the call first and may change the figure. Refused when calls are off, the candidate has no Indian mobile or opted out, a call is already arranged, or the assistant already spoke with them about pay.",
    input: z.object({
      negotiationId: z.string().uuid(),
      improvedCtc: z.number().positive().nullable(),
      /** What the call may explain; the HR head approves it with the call. */
      brief: z
        .object({
          fixedCtc: z.number().positive().nullable().optional(),
          variableCtc: z.number().positive().nullable().optional(),
          esop: z.string().max(300).nullable().optional(),
          esopValue: z.number().positive().nullable().optional(),
          review: z.string().max(300).nullable().optional(),
          benefits: z.string().max(300).nullable().optional(),
          rationale: z.string().max(300).nullable().optional(),
          whyYou: z.array(z.string().min(3).max(200)).max(3).optional(),
        })
        .nullable()
        .optional(),
    }),
    risk: "external",
    // No template: a pay call is never pre-approved, so the HR head always approves it.
    templateOf: () => null,
    approverRole: "hr_head",
    skills: ["negotiation_call"],
    describe: (i) =>
      i.improvedCtc == null
        ? "Phone the candidate about pay (hold at the proposal)"
        : `Phone the candidate about pay (may move once, to ${rupees(i.improvedCtc)})`,
    precheck: async (ctx, i) => {
      const { checkNegotiationCall } = await import("../voice/negotiation-request.server");
      const c = await checkNegotiationCall(ctx.orgId, i.negotiationId, {
        step: i.improvedCtc,
        brief: i.brief ?? null,
      });
      return c.ok ? null : c.reason;
    },
    // Stated by the system on the approval card: exactly what the call may say.
    brief: async (ctx, i) => {
      const { checkNegotiationCall } = await import("../voice/negotiation-request.server");
      const c = await checkNegotiationCall(ctx.orgId, i.negotiationId, { step: i.improvedCtc });
      if (!c.ok) return "";
      const n = c.negotiation;
      const { leverSentence } = await import("../voice/negotiation-call-tools");
      return [
        "The AI assistant phones the candidate, says it is an AI, and talks through the pay:",
        `• The proposal: ${rupees(Number(n.proposedCtc))} a year.${leverSentence(n.levers ?? {})}`,
        i.improvedCtc == null
          ? "• It holds there: if they want more, their words come back to the team."
          : `• If they turn it down, it may offer ${rupees(i.improvedCtc)} once — nothing else.`,
        ...(i.brief?.fixedCtc && i.brief.variableCtc
          ? [
              `• It may explain the split: ${rupees(i.brief.fixedCtc)} fixed + ${rupees(i.brief.variableCtc)} variable.`,
            ]
          : []),
        ...(i.brief?.esop
          ? [
              `• ESOPs: ${i.brief.esop}${i.brief.esopValue ? ` (${rupees(i.brief.esopValue)})` : ""}.`,
            ]
          : []),
        ...(i.brief?.review ? [`• The review: ${i.brief.review}`] : []),
        ...(i.brief?.benefits ? [`• Benefits: ${i.brief.benefits}`] : []),
        ...(i.brief?.rationale ? [`• How the figure was set: ${i.brief.rationale}`] : []),
        ...(i.brief?.whyYou?.length
          ? [`• Why the team wants them: ${i.brief.whyYou.join(" ")}`]
          : []),
        "• It offers the improvement only after they say they would go ahead if it improved.",
        `• It never says the ceiling (${rupees(Number(n.ceiling))}) or the band, and never agrees anything: a yes comes back to TA / the HR head to confirm in one click.`,
      ].join("\n");
    },
    run: async (ctx, i) => {
      const { requestNegotiationCall } = await import("../voice/negotiation-request.server");
      const r = await requestNegotiationCall({
        orgId: ctx.orgId,
        negotiationId: i.negotiationId,
        step: i.improvedCtc,
        brief: i.brief ?? null,
        requestedBy: ctx.principalUserId,
        requestedRunId: ctx.runId,
        actor: ctx.actor,
      });
      return { callId: r.callId, firstAttemptAt: r.dueAt.toISOString() };
    },
  });

  for (const name of NEGOTIATION_TOOL_NAMES) {
    registerTool({
      name,
      description: NEGOTIATION_TOOL_DESCRIPTIONS[name],
      input: NEGOTIATION_TOOL_INPUTS[name] as z.ZodType<Record<string, unknown>>,
      risk: "write",
      describe: () => `On the call: ${name.replace(/_/g, " ")}`,
      run: async (ctx, i) => applyToCall(ctx, name, i),
    });
  }
}
