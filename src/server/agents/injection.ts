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
  /<\s*\/?\s*untrusted[\s_-]*data/i,
  /\b(rate|score|mark)\s+(this|me|the)\s+(candidate\s+)?(as\s+)?(10|ten|100|the\s+(highest|best)|a\s+perfect)\b/i,
  /\b(assign|give|award)\s+(this\s+candidate\s+|me\s+|them\s+)?(a\s+|the\s+)?(top|highest|maximum|max|perfect|full)\s+(rating|score|marks)\b/i,
  /\b(bypass|skip|override)\s+(the\s+|all\s+|any\s+)?(standard\s+)?(screening|evaluation|assessment|scoring)\b/i,
  // The extraction pipeline already flagged this candidate.
  /"injectionFlag"\s*:\s*true/,
];

/** Zero-width, soft-hyphen and bidi controls — stripped so they cannot split a keyword. */
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function looksLikeInjection(text: string): boolean {
  if (!text) return false;
  const plain = text.replace(INVISIBLE_CHARS, "");
  return PATTERNS.some((p) => p.test(plain));
}
