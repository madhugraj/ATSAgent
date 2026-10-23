/**
 * Phone screening tools (docs/voice-screening-agent.md).
 *
 * - request_screening_call: the Screening agent asks for a call; a person
 *   approves it unless the agent is Autonomous (or the template is
 *   pre-approved). The voice worker places it later, inside the calling window.
 * - The Screening call agent's in-call tools: the same contracts the live call
 *   uses (src/server/voice/call-tools.ts). On a live call the voice worker
 *   applies them directly; here they let the agent run in text mode (evals) —
 *   against the in-progress call its run belongs to.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { screeningCalls } from "@db/schema";
import { db } from "../db";
import {
  applyCallTool,
  CALL_TOOL_DESCRIPTIONS,
  CALL_TOOL_INPUTS,
  CALL_TOOL_NAMES,
  freshCallState,
  type CallToolName,
} from "../voice/call-tools";
import { registerTool, type ToolContext } from "./registry";

/** The call this run is working on: its own, or (text mode) the org's unclaimed call in progress. */
async function callForRun(ctx: ToolContext) {
  const [own] = await db
    .select()
    .from(screeningCalls)
    .where(and(eq(screeningCalls.orgId, ctx.orgId), eq(screeningCalls.agentRunId, ctx.runId)))
    .limit(1);
  if (own) return own;
  const [free] = await db
    .select()
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, ctx.orgId),
        eq(screeningCalls.status, "in_progress"),
        isNull(screeningCalls.agentRunId),
      ),
    )
    .orderBy(desc(screeningCalls.updatedAt))
    .limit(1);
  if (!free) throw new Error("There is no call in progress for this run.");
  await db
    .update(screeningCalls)
    .set({ agentRunId: ctx.runId, updatedAt: new Date() })
    .where(eq(screeningCalls.id, free.id));
  return { ...free, agentRunId: ctx.runId };
}

/** Apply one in-call tool to the call row (text mode); same rules as the live call. */
async function applyToCall(ctx: ToolContext, name: CallToolName, input: unknown) {
  const call = await callForRun(ctx);
  const questionIds = new Set<string>();
  if (call.kitId && call.applicationId) {
    const { loadBriefFacts } = await import("../voice/call-brief.server");
    const { phoneScreeningPolicyOf } = await import("../voice/settings.server");
    const facts = await loadBriefFacts({
      orgId: ctx.orgId,
      applicationId: call.applicationId,
      kitId: call.kitId,
      policy: await phoneScreeningPolicyOf(ctx.orgId),
    });
    for (const q of facts.questions) questionIds.add(q.id);
  }
  const state = {
    ...freshCallState(),
    consent: call.consentAt ? true : call.status === "consent_declined" ? false : null,
    answers: call.answers,
  };
  const out = applyCallTool(state, name, input, questionIds, Date.now());
  if (!out["ok"]) throw new Error(String(out["error"] ?? "Not recorded."));
  await db
    .update(screeningCalls)
    .set({
      consentAt: state.consent === true ? (call.consentAt ?? new Date()) : null,
      answers: state.consent === true ? state.answers : [],
      ...(state.consent === false ? { status: "consent_declined" as const } : {}),
      ...(state.callback ? { status: "callback" as const } : {}),
      ...(state.endReason ? { endReason: state.endReason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(screeningCalls.id, call.id));
  if (name === "record_availability" && state.availability && call.applicationId) {
    const { recordCallAvailability } = await import("@/lib/compensation.server");
    const a = state.availability;
    const r = await recordCallAvailability(ctx.orgId, call.applicationId, {
      noticePeriodDays: a.notice_period_days ?? null,
      earliestJoining: a.earliest_joining ?? null,
      currentLocation: a.current_location ?? null,
      openToRelocate: a.open_to_relocate ?? null,
    });
    return { ...out, recorded: r.recorded };
  }
  return out;
}

export function registerScreeningCallTools(): void {
  registerTool({
    name: "request_screening_call",
    description:
      "Ask for an AI screening call to a shortlisted candidate: the Screening call agent phones them inside the organisation's calling window, asks the screening kit's questions (never pay), and the answers come back graded. Refused when phone screening is off, the kit is missing, the candidate has no Indian mobile number, a call is already arranged, or they were already called — then use send_assessment.",
    input: z.object({ applicationId: z.string().uuid() }),
    risk: "external",
    // Pre-approvable like a candidate message: Autonomous, or the org whitelists it.
    templateOf: () => "screening_call",
    skills: ["screening_call", "screening_grade"],
    describe: () => "Phone the candidate for an AI screening call",
    precheck: async (ctx, i) => {
      const { checkScreeningCall } = await import("../voice/request.server");
      const c = await checkScreeningCall(ctx.orgId, i.applicationId);
      return c.ok ? null : c.reason;
    },
    run: async (ctx, i) => {
      const { requestScreeningCall } = await import("../voice/request.server");
      const r = await requestScreeningCall({
        orgId: ctx.orgId,
        applicationId: i.applicationId,
        requestedBy: ctx.principalUserId,
        requestedRunId: ctx.runId,
        actor: ctx.actor,
      });
      return { callId: r.callId, firstAttemptAt: r.dueAt.toISOString() };
    },
  });

  for (const name of CALL_TOOL_NAMES) {
    registerTool({
      name,
      description: CALL_TOOL_DESCRIPTIONS[name],
      input: CALL_TOOL_INPUTS[name] as z.ZodType<Record<string, unknown>>,
      risk: "write",
      describe: () => `On the call: ${name.replace(/_/g, " ")}`,
      run: async (ctx, i) => applyToCall(ctx, name, i),
    });
  }
}
