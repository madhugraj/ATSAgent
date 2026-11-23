/**
 * The assistant must never read out its own workings: tool calls, code, JSON or
 * its reasoning. A screening test call on 10 November spoke a block of code and
 * "Wait, I shouldn't call record_details here…" to the candidate. All three AI
 * phone calls watch the assistant's words as they are transcribed and stop the
 * line the moment they look like this (pure; unit-tested).
 */

/** Tool names of all three calls — never words a person says on a call. */
const TOOL_NAMES =
  /\b(record_details|record_answer|record_consent|end_call|book_slot|record_availability|record_permission|end_scheduling_call|end_negotiation_call|record_call_notes|record_their_position|state_offer|explain_offer|request_human_call|action_input|tool_call|function_call)\b/i;
/** Code fences, JSON keys, reasoning labels. */
const CODE_OR_REASONING = /```|\{\s*"|"\s*:\s*[{["]|\b(thought|reasoning)\s*"?\s*:/i;

/** The assistant's words so far read out its workings (a tool call, code or reasoning). */
export function readsOutWorkings(said: string): boolean {
  return TOOL_NAMES.test(said) || CODE_OR_REASONING.test(said);
}

/** Sent after the line is stopped. */
export const WORKINGS_CORRECTION =
  '(STOP. You read out a tool call, code or your own reasoning, and the candidate heard it. Say only: "Sorry about that — let me say that again." Then your last question, in plain words. Call tools silently; never say a tool name, code or your reasoning out loud.)';
