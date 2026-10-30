/**
 * Writes docs/voice-agents-charter.md from the voice agents' charter
 * (src/server/voice/charter.ts) — run after changing the charter:
 *
 *   bun scripts/voice-charter-doc.ts
 *
 * scripts/voice-charter.test.ts fails when the doc and the charter differ.
 */
import { writeFileSync } from "node:fs";

import {
  SCHEDULING_CALL_CHARTER,
  SCREENING_CALL_CHARTER,
  type Rule,
  type VoiceCharter,
} from "../src/server/voice/charter";

const NAME: Record<VoiceCharter["agent"], string> = {
  screening_call: "Screening call agent",
  scheduling_call: "Scheduling call agent",
  negotiation_call: "Negotiation call agent",
};

const rows = (title: string, rs: Rule[]) => [
  `**${title}**`,
  "",
  "| Rule | Held by |",
  "|---|---|",
  ...rs.map(
    (r) =>
      `| ${r.rule.replace(/\|/g, "\\|")} | ${r.enforced === "code" ? "code" : "instruction + evals"} |`,
  ),
  "",
];

export function charterDoc(): string {
  const out = [
    "# Voice agents — charter",
    "",
    "Generated from `src/server/voice/charter.ts` by `bun scripts/voice-charter-doc.ts`; do not edit by hand.",
    "",
    "Every AI phone agent has one written charter: its purpose, what it must say, the only things it",
    "may talk about, what it must never do, what it hands to a person, and its tone. The same text is",
    "printed into every call's instructions, is the agent's must-never list in its manifest (so a change",
    "needs a new version and a refreshed agents lock), and is checked by tests.",
    "",
    "**Held by code** means the system enforces it whatever the model says — a tool refuses (no",
    "consent before the disclosure, no time that is not in the list, no round other than the current",
    "one), or the system states the fact (where the candidate stands, how many interviewers). **Held",
    "by instruction** means the model is told and the evals check it; those are the rules to watch on",
    "real calls.",
    "",
    "Staff are confidential: no voice agent names or describes the hiring manager, recruiters or the",
    "interview panel. The call's facts carry only how many interviewers there are, and the only",
    "contact given is the organisation's mailbox.",
    "",
  ];
  for (const ch of [SCREENING_CALL_CHARTER, SCHEDULING_CALL_CHARTER]) {
    out.push(`## ${NAME[ch.agent]} (\`${ch.agent}\`)`, "", `**Purpose:** ${ch.purpose}`, "");
    out.push(...rows("Must say", ch.mustSay));
    out.push(...rows("May talk about only", ch.may));
    out.push(...rows("Must never", ch.mustNot));
    out.push(...rows("Hands to a person", ch.handOff));
    out.push(...rows("Tone", ch.tone));
  }
  return out.join("\n");
}

if (import.meta.main) {
  writeFileSync(new URL("../docs/voice-agents-charter.md", import.meta.url), charterDoc());
  console.log("docs/voice-agents-charter.md written");
}
