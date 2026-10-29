/**
 * The organisation profile's shape and its refusals (docs/org-context-agent-plan.md).
 * Pure and client-safe: the Profile page uses it to show defaults and the
 * diff, and the server uses the same checks before anything is saved.
 *
 * Items never hold pay figures (the pay philosophy in words is fine) or the
 * names, e-mails or phone numbers of staff — those are refused with a reason.
 */
import type { OrgProfileItemRow } from "@db/schema";

export type OrgProfileItem = OrgProfileItemRow;
export type Visibility = OrgProfileItem["visibility"];
export type OrgProfileSections = Record<string, OrgProfileItem[]>;

export type SectionDef = {
  key: string;
  title: string;
  /** What belongs here, shown to the person editing. */
  hint: string;
  /** Visibility a new item starts with. */
  defaultVisibility: Visibility;
  /** Never said to candidates, whatever the person picks. */
  internalOnly?: boolean;
};

export const PROFILE_SECTIONS: SectionDef[] = [
  {
    key: "about",
    title: "About",
    hint: "What the organisation does, in two or three sentences; founded, size, ownership.",
    defaultVisibility: "candidate",
  },
  {
    key: "products",
    title: "Products and services",
    hint: "Named products or service lines, one line each, and who uses them.",
    defaultVisibility: "candidate",
  },
  {
    key: "customers",
    title: "Customers and markets",
    hint: "Customer segments (retail, enterprise, patients, government) and where you serve them.",
    defaultVisibility: "candidate",
  },
  {
    key: "domain",
    title: "Domain and regulators",
    hint: "Your domain (banking, healthcare, technology…) and the regulators or frameworks that bind hiring or the work (e.g. RBI, SEBI, NABH, DPDP Act, ISO 27001).",
    defaultVisibility: "internal",
  },
  {
    key: "locations",
    title: "Locations and work modes",
    hint: "Offices and sites, which work modes each supports (onsite, hybrid, remote), shifts where relevant.",
    defaultVisibility: "candidate",
  },
  {
    key: "structure",
    title: "Structure",
    hint: "Departments, what each does and the kinds of roles in it; reporting lines by title, never by name.",
    defaultVisibility: "internal",
    internalOnly: true,
  },
  {
    key: "culture",
    title: "Culture and values",
    hint: "Stated values, ways of working, learning and growth — in your own words.",
    defaultVisibility: "candidate",
  },
  {
    key: "hiring_norms",
    title: "Hiring norms",
    hint: "Usual interview rounds, notice you accept, joining practice, probation, whether bands are shared, and your pay philosophy in words — never figures.",
    defaultVisibility: "internal",
  },
  {
    key: "policies",
    title: "Policies that affect hiring",
    hint: "Diversity commitments, background and reference checks, licence verification, candidate data handling, relatives and rehire policies.",
    defaultVisibility: "internal",
  },
  {
    key: "tone",
    title: "Tone of voice",
    hint: "How you speak to candidates: formal or warm, words you use and avoid, languages.",
    defaultVisibility: "internal",
    internalOnly: true,
  },
  {
    key: "never_say",
    title: "Never say to candidates",
    hint: "Topics and claims agents must never make: unreleased products, clients under NDA, litigation, restructuring, “guaranteed” anything.",
    defaultVisibility: "internal",
    internalOnly: true,
  },
];

export const SECTION_BY_KEY = new Map(PROFILE_SECTIONS.map((s) => [s.key, s]));
export const MAX_ITEMS_PER_SECTION = 30;
export const MAX_ITEM_CHARS = 600;

/* ------------------------------------------------------------ pay figures */

const PAY_WORD =
  /\b(pay|pays|paid|salary|salaries|ctc|compensation|package|wages?|bonus(es)?|incentives?|stipends?|increments?|hikes?|bands?|budgets?|remuneration|earn(s|ings?)?|variable|esops?|allowances?|perks?)\b/i;
const CURRENCY_AMOUNT =
  /(₹|\$|€|£|\b(rs|inr|usd|eur|gbp|aed|sgd)\.?)\s?\d|\d[\d,.]*\s?(₹|\b(inr|usd|eur|gbp|aed|sgd|rupees?|dollars?|euros?|pounds?)\b)/i;
const LPA_FIGURE = /\d[\d,.]*\s?(lpa|l\.p\.a\.?|ctc)\b/i;
const SCALED_FIGURE = /\d[\d,.]*\s?(lakhs?|lacs?|crores?|cr|k|mn|million|thousand)\b/i;
const PERCENT = /\d[\d,.]*\s?(%|per\s?cent|percent)/i;

/** Words around `match` (same sentence, 60 chars each side) contain a pay word. */
function nearPayWord(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const start = Math.max(0, m.index! - 60);
    const end = Math.min(text.length, m.index! + m[0].length + 60);
    const window = text.slice(start, end);
    // Stay inside the sentence the figure is in.
    const before =
      window
        .slice(0, m.index! - start)
        .split(/[.;!?\n]/)
        .at(-1) ?? "";
    const after = window.slice(m.index! - start + m[0].length).split(/[.;!?\n]/)[0] ?? "";
    if (PAY_WORD.test(`${before} ${after}`)) return true;
  }
  return false;
}

/**
 * Why this text may not be kept because it states pay, or null. The pay
 * philosophy in words ("at or above the market median") is allowed.
 */
export function payFigureReason(text: string): string | null {
  if (CURRENCY_AMOUNT.test(text))
    return "It contains a money amount. Pay figures are never kept in the profile — describe your pay philosophy in words instead.";
  if (LPA_FIGURE.test(text))
    return "It contains a pay figure (LPA / CTC). Pay figures are never kept in the profile — describe your pay philosophy in words instead.";
  if (nearPayWord(text, SCALED_FIGURE))
    return "It contains a pay figure (lakh / crore / k). Pay figures are never kept in the profile — describe your pay philosophy in words instead.";
  if (nearPayWord(text, PERCENT))
    return "It contains a percentage about pay (e.g. a hike or bonus rate). Pay figures are never kept in the profile — describe your pay philosophy in words instead.";
  return null;
}

/* ------------------------------------------------------- staff and contacts */

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** Ten or more digits, allowing spaces, dashes, dots, brackets and a leading +. */
const PHONE = /(\+?\(?\d[\d\s().-]{8,}\d)/;

export type Person = { name: string | null; email?: string | null };

/** Lowercase, accent-folded, punctuation-free, single-spaced — the one normaliser for matching. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Full names worth matching: two or more words of two or more letters. */
export function nameKeys(people: Person[]): string[] {
  const keys = new Set<string>();
  for (const p of people) {
    const n = norm(p.name ?? "");
    const words = n.split(" ").filter((w) => w.length >= 2);
    if (words.length < 2) continue;
    keys.add(words.join(" "));
    // "Priya Raman" also matches "Priya S Raman" written as first + last.
    if (words.length > 2) keys.add(`${words[0]} ${words.at(-1)}`);
  }
  return [...keys];
}

/**
 * Why this text may not be kept because it names or contacts a person, or
 * null. `names` comes from `nameKeys` over the organisation's members and
 * HRMS employees. `orgNames` (the organisation's own and legal name) are taken
 * out of the text first: a person whose name is part of the organisation's name
 * ("Agent Demo" in "Agent Demo Org") is not named by naming the organisation.
 */
export function staffReason(text: string, names: string[], orgNames: string[] = []): string | null {
  if (EMAIL.test(text))
    return "It contains an e-mail address. The profile never holds contact details — describe roles by title.";
  const phone = text.match(PHONE)?.[0];
  if (phone && phone.replace(/\D/g, "").length >= 10)
    return "It contains a phone number. The profile never holds contact details — describe roles by title.";
  let hay = ` ${norm(text)} `;
  for (const o of orgNames.map(norm).filter((o) => o.split(" ").length >= 2))
    hay = hay.split(` ${o} `).join(" ");
  const hit = names.find((n) => hay.includes(` ${n} `));
  if (hit)
    return `It names a member of staff (${hit.replace(/\b\p{L}/gu, (c) => c.toUpperCase())}). The profile describes people by title, never by name.`;
  return null;
}

/* ------------------------------------------------------------ normalising */

export type Refusal = { section: string; itemId: string; text: string; reason: string };

/**
 * Clean the sections a person or agent sent: known sections only, trimmed,
 * empty items dropped, limits applied, internal-only sections forced to
 * internal. Returns the clean sections and what was refused (pay, staff).
 */
export function checkSections(
  input: OrgProfileSections,
  names: string[],
  orgNames: string[] = [],
): { sections: OrgProfileSections; refused: Refusal[]; problems: string[] } {
  const sections: OrgProfileSections = {};
  const refused: Refusal[] = [];
  const problems: string[] = [];
  for (const [key, items] of Object.entries(input ?? {})) {
    const def = SECTION_BY_KEY.get(key);
    if (!def) {
      problems.push(`Unknown section "${key}".`);
      continue;
    }
    const kept: OrgProfileItem[] = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const text = String(raw?.text ?? "").trim();
      if (!text) continue;
      if (text.length > MAX_ITEM_CHARS) {
        problems.push(`${def.title}: an item is longer than ${MAX_ITEM_CHARS} characters.`);
        continue;
      }
      const itemId = String(raw?.id ?? "").slice(0, 64) || crypto.randomUUID();
      const reason = payFigureReason(text) ?? staffReason(text, names, orgNames);
      if (reason) {
        refused.push({ section: key, itemId, text, reason });
        continue;
      }
      kept.push({
        id: itemId,
        text,
        visibility: def.internalOnly
          ? "internal"
          : raw?.visibility === "candidate"
            ? "candidate"
            : "internal",
        source:
          raw?.source && typeof raw.source === "object" && "kind" in raw.source
            ? raw.source
            : { kind: "person" },
      });
    }
    if (kept.length > MAX_ITEMS_PER_SECTION)
      problems.push(`${def.title}: at most ${MAX_ITEMS_PER_SECTION} items.`);
    if (kept.length) sections[key] = kept.slice(0, MAX_ITEMS_PER_SECTION);
  }
  return { sections, refused, problems };
}

/* ------------------------------------------------------------------- diff */

export type SectionDiff = {
  section: string;
  title: string;
  added: OrgProfileItem[];
  removed: OrgProfileItem[];
  changed: { before: OrgProfileItem; after: OrgProfileItem }[];
};

/** What a version changes against the approved one, by section (empty sections omitted). */
export function diffSections(
  approved: OrgProfileSections | null,
  next: OrgProfileSections,
): SectionDiff[] {
  const out: SectionDiff[] = [];
  for (const def of PROFILE_SECTIONS) {
    const before = approved?.[def.key] ?? [];
    const after = next[def.key] ?? [];
    const beforeById = new Map(before.map((i) => [i.id, i]));
    const afterIds = new Set(after.map((i) => i.id));
    const added: OrgProfileItem[] = [];
    const changed: SectionDiff["changed"] = [];
    for (const item of after) {
      const prev = beforeById.get(item.id);
      if (!prev) added.push(item);
      else if (prev.text !== item.text || prev.visibility !== item.visibility)
        changed.push({ before: prev, after: item });
    }
    const removed = before.filter((i) => !afterIds.has(i.id));
    if (added.length || removed.length || changed.length)
      out.push({ section: def.key, title: def.title, added, removed, changed });
  }
  return out;
}

/** Every item candidates may hear or read, in section order (shown to the approver). */
export function candidateVisible(sections: OrgProfileSections): { title: string; text: string }[] {
  return PROFILE_SECTIONS.flatMap((def) =>
    (sections[def.key] ?? [])
      .filter((i) => i.visibility === "candidate" && !def.internalOnly)
      .map((i) => ({ title: def.title, text: i.text })),
  );
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Waiting for approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  declined: "Declined",
  superseded: "Replaced by a later version",
};

/* ------------------------------------------------- internal lines in a JD */

export type InternalLineHit = { section: string; itemId: string; reason: string };

/** The never-say claims that are matchable as sentences (topics are not; those stay prompt rules). */
const ABSOLUTE_CLAIM =
  /\b(guarantee[sd]?|assured|100%)\b[^.!?]{0,40}\b(job|offer|placement|selection|hiring|joining)\b/i;

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

/**
 * Whether two lines say the same fact in other words: ≥ 75 % stemmed-word
 * containment (the shorter line's words almost all appear in the longer —
 * a paraphrase-expansion, not a new fact). Used to keep near-duplicate
 * rewordings out of a profile draft.
 */
export function nearDuplicate(a: string, b: string): boolean {
  const stem = (s: string) =>
    norm(s)
      .split(" ")
      .filter(Boolean)
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
  const wa = stem(a);
  const wb = stem(b);
  if (!wa.length || !wb.length) return false;
  const sb = new Set(wb);
  let inter = 0;
  for (const w of new Set(wa)) if (sb.has(w)) inter++;
  return inter / Math.min(new Set(wa).size, sb.size) >= 0.75;
}

/** Phrases an internal item could leak as: the whole line, each sentence, and a leading clause. */
function internalPhrases(text: string): string[] {
  const phrases = new Set<string>();
  const whole = norm(text);
  if (whole.split(" ").length >= 5) phrases.add(whole);
  for (const sentence of text.split(/[.;!?\n]/)) {
    const s = norm(sentence);
    const words = s.split(" ").filter(Boolean);
    if (words.length >= 5 && words.length <= 80) phrases.add(s);
  }
  const lead = whole.split(" ").slice(0, 12).join(" ");
  if (whole.split(" ").length > 12) phrases.add(lead);
  return [...phrases];
}

/**
 * Why this JD text may not be saved because it repeats an internal-only
 * profile line (or makes an absolute claim the never-say list exists for),
 * or null. Pure and deterministic: normalised substring or ≥0.8 word overlap.
 */
export function internalLineReason(
  fullText: string,
  sections: OrgProfileSections,
  opts?: { minWords?: number },
): InternalLineHit | null {
  if (ABSOLUTE_CLAIM.test(fullText))
    return {
      section: "never_say",
      itemId: "absolute_claim",
      reason:
        "It makes an absolute guarantee about a job or offer. The profile's never-say list exists so candidates never read a claim like that.",
    };
  const minWords = opts?.minWords ?? 5;
  const hayNorm = norm(fullText);
  const hayWords = hayNorm.split(" ");
  for (const def of PROFILE_SECTIONS) {
    for (const item of sections[def.key] ?? []) {
      if (item.visibility !== "internal" && !def.internalOnly) continue;
      const t = item.text.trim();
      if (norm(t).split(" ").length < 2 && t.length < 12) continue;
      for (const phrase of internalPhrases(t)) {
        const words = phrase.split(" ").filter(Boolean);
        if (words.length < Math.max(2, minWords) && phrase.length < 12) continue;
        if (hayNorm.includes(phrase))
          return {
            section: def.key,
            itemId: item.id,
            reason: `It repeats an internal-only profile line — candidates must never read it (${def.title.toLowerCase()}).`,
          };
        // Same window count, ≥0.8 overlap: a lightly reworded copy.
        if (words.length >= 5 && hayWords.length >= words.length) {
          for (let i = 0; i + words.length <= hayWords.length; i++) {
            if (jaccard(words, hayWords.slice(i, i + words.length)) >= 0.8)
              return {
                section: def.key,
                itemId: item.id,
                reason: `It repeats an internal-only profile line in other words — candidates must never read it (${def.title.toLowerCase()}).`,
              };
          }
        }
      }
    }
  }
  return null;
}
