/**
 * Opt-in call-audio timing for diagnosing choppy speech (VOICE_DEBUG_FILE set on the
 * voice worker only): when each chunk of the model's audio arrived, its size and
 * declared format, and when the line started and ran out of speech. Never audio,
 * words or anything about the candidate.
 */
import { appendFileSync } from "node:fs";

export function voiceDebug(event: Record<string, unknown>): void {
  const file = process.env["VOICE_DEBUG_FILE"];
  if (!file) return;
  appendFileSync(file, JSON.stringify({ t: Math.round(performance.now()), ...event }) + "\n");
}
