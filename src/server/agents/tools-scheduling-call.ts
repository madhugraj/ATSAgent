/**
 * Scheduling call tools (docs/voice-scheduling-call-plan.md).
 *
 * - request_scheduling_call: the Interview coordinator asks for a short AI call
 *   to a candidate who has not picked one of the e-mailed interview times. A
 *   person approves it (or the organisation pre-approved the template); every
 *   rule — the wait, a day ahead, the opt-out, one call per offer — is checked
 *   by the system. The approval card states the times the call will offer.
 * - The Scheduling call agent's in-call tools: the same contracts the live call
 *   uses (src/server/voice/scheduling-call-tools.ts), here applied in text mode
 *   (evals) to the in-progress scheduling call the run belongs to — booking
 *   through the same core as the e-mailed link.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { screeningCalls } from "@db/schema";
import { db } from "../db";
import {
  applySchedulingTool,
  freshSchedulingState,
  SCHEDULING_TOOL_DESCRIPTIONS,
  SCHEDULING_TOOL_INPUTS,
  SCHEDULING_TOOL_NAMES,
  type Availability,
  type SchedulingEndReason,
  type SchedulingToolName,
} from "../voice/scheduling-call-tools";
import { registerTool, type ToolContext } from "./registry";

/** The scheduling call this run is working on: its own, or (text mode) the org's unclaimed one. */
async function callForRun(ctx: ToolContext) {
  const [own] = await db
    .select()
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, ctx.orgId),
        eq(screeningCalls.agentRunId, ctx.runId),
        eq(screeningCalls.purpose, "scheduling"),
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
        eq(screeningCalls.purpose, "scheduling"),
        eq(screeningCalls.status, "in_progress"),
        isNull(screeningCalls.agentRunId),
      ),
    )
    .orderBy(desc(screeningCalls.updatedAt))
    .limit(1);
  if (!free) throw new Error("There is no scheduling call in progress for this run.");
  await db
    .update(screeningCalls)
    .set({ agentRunId: ctx.runId, updatedAt: new Date() })
    .where(eq(screeningCalls.id, free.id));
  return { ...free, agentRunId: ctx.runId };
}

async function applyToCall(ctx: ToolContext, name: SchedulingToolName, input: unknown) {
  const call = await callForRun(ctx);
  const { loadSchedulingBrief } = await import("../voice/scheduling-brief.server");
  const brief = await loadSchedulingBrief(ctx.orgId, call.id);
  if (!brief) throw new Error("This call's interview offer was not found.");
  const state = {
    ...freshSchedulingState(),
    permission: call.consentAt ? true : call.consentWords ? false : null,
    booked: call.endReason === "booked" ? { option: 0, at: "" } : null,
  };
  const out = applySchedulingTool(state, name, input, brief.options);
  if (!out.ok) throw new Error(out.error);
  const outcome = await import("../voice/scheduling-outcome.server");
  switch (name) {
    case "record_permission":
      await db
        .update(screeningCalls)
        .set({
          consentAt: state.permission ? (call.consentAt ?? new Date()) : null,
          consentWords: state.permissionWords ?? null,
          updatedAt: new Date(),
        })
        .where(eq(screeningCalls.id, call.id));
      return { ok: true };
    case "book_interview_time": {
      const r = await outcome.bookByPhone(ctx.orgId, call, out.book!);
      if (!r.ok) throw new Error(r.error);
      return r;
    }
    case "record_availability":
      await outcome.noteAvailability(ctx.orgId, call, input as Availability);
      return { ok: true };
    case "end_scheduling_call":
      return {
        ok: true,
        status: await outcome.endSchedulingCall(
          ctx.orgId,
          call,
          (input as { reason: SchedulingEndReason }).reason,
          ctx.actor,
        ),
      };
  }
}

export function registerSchedulingCallTools(): void {
  registerTool({
    name: "request_scheduling_call",
    description:
      "Ask for a short AI call to a candidate who has not picked one of the interview times e-mailed to them: the Scheduling call agent phones them inside the calling window and books one of those times (or up to three more that are free for the interviewers), or notes when they are free. Refused when scheduling calls are off, no e-mailed times are waiting, the times were sent less than the organisation's wait ago (a repeat offer after a decline or expiry is called about at once), the earliest time is less than a day away, the candidate has no Indian mobile or asked not to be called, or a call was already arranged — then leave it to the e-mail.",
    input: z.object({ applicationId: z.string().uuid() }),
    risk: "external",
    templateOf: () => "scheduling_call",
    skills: ["scheduling_call"],
    describe: () => "Phone the candidate to pick an interview time",
    precheck: async (ctx, i) => {
      const { checkSchedulingCall } = await import("../voice/scheduling-request.server");
      const c = await checkSchedulingCall(ctx.orgId, i.applicationId);
      return c.ok ? null : c.reason;
    },
    // Stated by the system on the approval card: what the call will offer.
    brief: async (ctx, i) => {
      const { checkSchedulingCall } = await import("../voice/scheduling-request.server");
      const c = await checkSchedulingCall(ctx.orgId, i.applicationId);
      if (!c.ok) return "";
      const { spokenWhen } = await import("../voice/scheduling-brief.server");
      const { getOrgEmailSettings } = await import("@/lib/email-outbox.server");
      const tz = (await getOrgEmailSettings(ctx.orgId)).timezone;
      return [
        `The AI assistant phones the candidate${c.repeat ? " now (they did not take the earlier times)" : " (the e-mailed times have had no answer)"} and books one of these L${c.offer.level} interview times, or notes when they are free:`,
        ...c.offer.slots.map((s) => `• ${spokenWhen(s, tz)}`),
        "…or up to three more times that are free for the interviewers, checked when the call is arranged.",
        "It cannot change the interviewer, length or format, and never discusses pay or results.",
      ].join("\n");
    },
    run: async (ctx, i) => {
      const { requestSchedulingCall } = await import("../voice/scheduling-request.server");
      const r = await requestSchedulingCall({
        orgId: ctx.orgId,
        applicationId: i.applicationId,
        requestedBy: ctx.principalUserId,
        requestedRunId: ctx.runId,
        actor: ctx.actor,
      });
      return { callId: r.callId, firstAttemptAt: r.dueAt.toISOString(), timesToOffer: r.options };
    },
  });

  for (const name of SCHEDULING_TOOL_NAMES) {
    registerTool({
      name,
      description: SCHEDULING_TOOL_DESCRIPTIONS[name],
      input: SCHEDULING_TOOL_INPUTS[name] as z.ZodType<Record<string, unknown>>,
      risk: "write",
      describe: () => `On the call: ${name.replace(/_/g, " ")}`,
      run: async (ctx, i) => applyToCall(ctx, name, i),
    });
  }
}
