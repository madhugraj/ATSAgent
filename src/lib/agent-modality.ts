/**
 * Voice vs text agents. Voice agents hold a live phone call with a candidate
 * (src/server/voice/); text agents work through tool-calling turns. The
 * governance, observability and intelligence pages filter by this so each
 * kind can be judged on its own terms. Client-safe: no server imports.
 */
import { z } from "zod";

export type AgentModality = "voice" | "text";
export type ModalityFilter = "all" | AgentModality;

/** Agents whose work is a live phone call. Add new call agents here. */
export const VOICE_AGENT_TYPES: readonly string[] = [
  "screening_call",
  "scheduling_call",
  "negotiation_call",
];

export const modalityFilterSchema = z.enum(["all", "voice", "text"]);

export const MODALITY_OPTIONS: { key: ModalityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "voice", label: "Voice" },
  { key: "text", label: "Text" },
];

export function agentModality(type: string): AgentModality {
  return VOICE_AGENT_TYPES.includes(type) ? "voice" : "text";
}

export function matchesModality(type: string, m: ModalityFilter | null | undefined): boolean {
  return !m || m === "all" || agentModality(type) === m;
}

export function modalityLabel(m: ModalityFilter | null | undefined): string | null {
  return m === "voice" ? "Voice agents" : m === "text" ? "Text agents" : null;
}
