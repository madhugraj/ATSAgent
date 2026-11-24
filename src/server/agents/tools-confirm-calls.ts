/**
 * In-call tools of the Confirmation call agent and the Panel time-check call
 * agent (migration 0092): the same contracts the live calls use
 * (src/server/voice/confirm-call-tools.ts), applied in text mode (evals) to
 * the in-progress call the run belongs to — answers recorded through the same
 * core as the e-mailed confirm link. No tool here moves, cancels or books an
 * interview: a "can't make it" goes to the hiring team.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { screeningCalls } from "@db/schema";
import { db } from "../db";
import {
  applyConfirmationTool,
  applyPanelTool,
  CONFIRMATION_TOOL_DESCRIPTIONS,
  CONFIRMATION_TOOL_INPUTS,
  CONFIRMATION_TOOL_NAMES,
  confirmationOutcome,
  freshConfirmationState,
  freshPanelCheckState,
  PANEL_TOOL_DESCRIPTIONS,
  PANEL_TOOL_INPUTS,
  PANEL_TOOL_NAMES,
  panelCheckOutcome,
  type ConfirmationEndReason,
  type PanelEndReason,
} from "../voice/confirm-call-tools";
import { registerTool, type ToolContext } from "./registry";

type Purpose = "confirmation" | "panel_check";

/** The call this run is working on: its own, or (text mode) the org's unclaimed one. */
async function callForRun(ctx: ToolContext, purpose: Purpose) {
  const [own] = await db
    .select()
    .from(screeningCalls)
    .where(
      and(
        eq(screeningCalls.orgId, ctx.orgId),
        eq(screeningCalls.agentRunId, ctx.runId),
        eq(screeningCalls.purpose, purpose),
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
        eq(screeningCalls.purpose, purpose),
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

async function saveGoAhead(
  callId: string,
  state: { permission: boolean | null; permissionWords?: string },
  had: Date | null,
) {
  await db
    .update(screeningCalls)
    .set({
      consentAt: state.permission ? (had ?? new Date()) : null,
      consentWords: state.permissionWords ?? null,
      updatedAt: new Date(),
    })
    .where(eq(screeningCalls.id, callId));
}

async function confirmationTool(ctx: ToolContext, name: string, input: unknown) {
  const call = await callForRun(ctx, "confirmation");
  const srv = await import("../voice/confirm-calls.server");
  const brief = await srv.loadConfirmationBrief(ctx.orgId, call);
  const state = {
    ...freshConfirmationState(),
    permission: call.consentAt ? true : call.consentWords ? false : null,
  };
  const out = applyConfirmationTool(state, name, input);
  if (!out.ok) throw new Error(out.error);
  if (name === "record_attendance_go_ahead") {
    await saveGoAhead(call.id, state, call.consentAt);
    return { ok: true };
  }
  if (out.answer) {
    if (!brief) throw new Error("There is nothing left to confirm for this interview.");
    const r = await srv.answerAttendance(brief.row, out.answer.attend, out.answer.words);
    if (!r.ok) throw new Error(r.error);
    await db
      .update(screeningCalls)
      .set({ endReason: out.answer.attend ? "confirmed" : "cannot_attend", updatedAt: new Date() })
      .where(eq(screeningCalls.id, call.id));
    return { ok: true, recorded: out.answer.attend ? "confirmed" : "cannot_attend" };
  }
  // end_confirmation_call
  const reason = (input as { reason: ConfirmationEndReason }).reason;
  const answered =
    call.endReason === "confirmed" || call.endReason === "cannot_attend"
      ? { attend: call.endReason === "confirmed", words: "" }
      : null;
  const result = confirmationOutcome({ permission: state.permission, answer: answered, endReason: reason });
  const r = await srv.settleAnswerCall(ctx.orgId, call, result, Date.now(), { endReason: reason });
  return { ok: true, status: r.status };
}

async function panelTool(ctx: ToolContext, name: string, input: unknown) {
  const call = await callForRun(ctx, "panel_check");
  const srv = await import("../voice/confirm-calls.server");
  const brief = await srv.loadPanelBrief(ctx.orgId, call);
  const state = {
    ...freshPanelCheckState(),
    permission: call.consentAt ? true : call.consentWords ? false : null,
  };
  const out = applyPanelTool(state, name, input, brief?.times ?? []);
  if (!out.ok) throw new Error(out.error);
  if (name === "record_panel_go_ahead") {
    await saveGoAhead(call.id, state, call.consentAt);
    return { ok: true };
  }
  if (out.answer) {
    if (!brief) throw new Error("There is nothing left to answer for this interview.");
    const r = await srv.answerPanelTimes(brief.row, out.answer.canDo, out.answer.words);
    if (!r.ok) throw new Error(r.error);
    await db
      .update(screeningCalls)
      .set({ endReason: "answered", updatedAt: new Date() })
      .where(eq(screeningCalls.id, call.id));
    return { ok: true, can_do: out.answer.canDo.length };
  }
  const reason = (input as { reason: PanelEndReason }).reason;
  const result = panelCheckOutcome({
    permission: state.permission,
    answer: call.endReason === "answered" ? { canDo: [], words: "" } : null,
    endReason: reason,
  });
  const r = await srv.settleAnswerCall(ctx.orgId, call, result, Date.now(), { endReason: reason });
  return { ok: true, status: r.status };
}

export function registerConfirmCallTools(): void {
  for (const name of CONFIRMATION_TOOL_NAMES) {
    registerTool({
      name,
      description: CONFIRMATION_TOOL_DESCRIPTIONS[name],
      input: CONFIRMATION_TOOL_INPUTS[name] as z.ZodType<Record<string, unknown>>,
      risk: "write",
      describe: () => `On the call: ${name.replace(/_/g, " ")}`,
      run: async (ctx, i) => confirmationTool(ctx, name, i),
    });
  }
  for (const name of PANEL_TOOL_NAMES) {
    registerTool({
        name,
        description: PANEL_TOOL_DESCRIPTIONS[name],
        input: PANEL_TOOL_INPUTS[name] as z.ZodType<Record<string, unknown>>,
        risk: "write",
        describe: () => `On the call: ${name.replace(/_/g, " ")}`,
        run: async (ctx, i) => panelTool(ctx, name, i),
      });
  }
}
