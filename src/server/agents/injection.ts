/**
 * Prompt-injection detection on third-party text that reaches an agent
 * (docs/agentic-plan.md §9.3, Phase 5 alerting).
 *
 * The defence is structural — untrusted() fencing plus INJECTION_RULES — so
 * this is a tripwire, not a filter: a match never changes what the model
 * sees, it marks the step, writes an audit entry and feeds the
 * `tools.injection` health rule. Patterns are deliberately narrow so a CV that
 * merely mentions "system design" does not fire.
 */
const PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|directions?)/i,
  /\byou\s+are\s+now\s+(an?\s+|the\s+)?[a-z]/i,
  /\b(reveal|print|show|repeat)\s+(your|the)\s+(system|developer)\s+(prompt|instructions?)/i,
  /\bnew\s+(system\s+)?instructions?\s*:/i,
  /<\/?\s*untrusted_data/i,
  /\b(rate|score|mark)\s+(this|me|the)\s+(candidate\s+)?(as\s+)?(10|ten|100|the\s+(highest|best)|a\s+perfect)\b/i,
  // The extraction pipeline already flagged this candidate.
  /"injectionFlag"\s*:\s*true/,
];

export function looksLikeInjection(text: string): boolean {
  if (!text) return false;
  return PATTERNS.some((p) => p.test(text));
}
