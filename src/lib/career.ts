/**
 * Career-history analytics — deterministic and auditable.
 *
 * The AI only *extracts* the employment history from the CV; every number and
 * flag below is computed in plain TypeScript so a recruiter can reproduce it by
 * hand and nobody is penalised by an opaque model guess.
 */

export type EmploymentRow = {
  company: string;
  title: string;
  /** ISO-ish start (YYYY-MM or YYYY). Null when the CV does not state it. */
  start: string | null;
  /** Null (or "present") means still employed there. */
  end: string | null;
  level_hint?: string | null;
};

export type CareerMetrics = {
  employers: number;
  dated_employers: number;
  total_years: number;
  avg_tenure_years: number;
  shortest_stint_years: number | null;
  current_tenure_years: number | null;
  jobs_last_5y: number;
  longest_gap_months: number;
  total_gap_months: number;
  promotions: number;
  progression: "upward" | "lateral" | "unclear";
  skill_recency_years: number | null;
};

const LEVELS: [RegExp, number][] = [
  [/\b(intern|trainee|graduate)\b/i, 0],
  [/\b(junior|associate|jr\.?)\b/i, 1],
  [/\b(engineer|developer|analyst|designer|consultant|specialist|executive)\b/i, 2],
  [/\b(senior|sr\.?|sde ?(?:ii|iii|3|2))\b/i, 3],
  [/\b(lead|principal|staff|architect|manager|supervisor)\b/i, 4],
  [/\b(head|director|senior manager|group manager)\b/i, 5],
  [/\b(vp|vice president|cto|ceo|cxo|chief|founder|partner)\b/i, 6],
];

export function titleLevel(title: string) {
  let level = -1;
  for (const [re, value] of LEVELS) if (re.test(title)) level = Math.max(level, value);
  return level;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Mar 2025", "March 2025", "2025-03", "03/2025", "2025" → the first of that month. */
function toDate(value: string | null | undefined, fallbackToNow = false) {
  if (!value || /present|current|till date|to date|now/i.test(value))
    return fallbackToNow ? new Date() : null;
  const v = value.toLowerCase();
  const y = v.match(/(19|20)\d{2}/);
  if (!y) return null;
  const year = Number(y[0]);
  if (year < 1950 || year > new Date().getFullYear() + 1) return null;
  let month = 0;
  const name = v.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
  const iso = v.match(/(?:19|20)\d{2}[-/.](\d{1,2})\b/);
  const us = v.match(/\b(\d{1,2})[-/.](?:19|20)\d{2}/);
  if (name) month = MONTHS.indexOf(name[1]!.slice(0, 3));
  else if (iso && Number(iso[1]) >= 1 && Number(iso[1]) <= 12) month = Number(iso[1]) - 1;
  else if (us && Number(us[1]) >= 1 && Number(us[1]) <= 12) month = Number(us[1]) - 1;
  return new Date(year, month, 1);
}

const YEAR_MS = 365.25 * 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Company names compared loosely: "Yavar Techworks Pvt. Ltd." = "yavar techworks". */
const companyKey = (c: string | null | undefined) =>
  (c ?? "")
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp|corporation|co|company|plc|gmbh)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Career metrics measured per EMPLOYER, not per title: consecutive roles at the
 * same company (gap under 3 months) are one tenure, and a title change inside it
 * is a promotion — not a job change. "Shortest stint" looks only at finished
 * tenures (a role still in progress is not short, it is current).
 */
export function computeCareerMetrics(
  history: EmploymentRow[],
  opts?: { skillRecencyYears?: number | null; now?: Date },
): CareerMetrics {
  const now = opts?.now ?? new Date();
  const rows = (history ?? []).filter((r) => r && (r.company || r.title));
  const roles = rows
    .map((r) => {
      const start = toDate(r.start);
      const ongoing = !r.end || /present|current|till date|to date|now/i.test(r.end);
      const end = ongoing ? now : toDate(r.end);
      if (!start || !end || end < start) return null;
      return { start, end, ongoing, title: r.title ?? "", company: companyKey(r.company) };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  // Employer tenures: merge consecutive roles at the same company.
  const MONTH = YEAR_MS / 12;
  type Tenure = { company: string; start: Date; end: Date; ongoing: boolean };
  const tenures: Tenure[] = [];
  for (const r of roles) {
    const last = tenures[tenures.length - 1];
    if (
      last &&
      r.company &&
      last.company === r.company &&
      r.start.getTime() - last.end.getTime() < 3 * MONTH
    ) {
      if (r.end > last.end) last.end = r.end;
      last.ongoing = last.ongoing || r.ongoing;
    } else tenures.push({ company: r.company, start: r.start, end: r.end, ongoing: r.ongoing });
  }

  const years = (t: Tenure) => (t.end.getTime() - t.start.getTime()) / YEAR_MS;
  const lengths = tenures.map(years);
  const totalYears = lengths.reduce((sum, t) => sum + t, 0);
  const finished = tenures.filter((t) => !t.ongoing).map(years);

  // Gaps between consecutive tenures (overlaps count as zero gap).
  let longestGap = 0;
  let totalGap = 0;
  for (let i = 1; i < tenures.length; i++) {
    const gapMonths = (tenures[i]!.start.getTime() - tenures[i - 1]!.end.getTime()) / MONTH;
    if (gapMonths > 1) {
      totalGap += gapMonths;
      longestGap = Math.max(longestGap, gapMonths);
    }
  }

  // Distinct employers worked for in the last five years.
  const fiveYearsAgo = new Date(now.getTime() - 5 * YEAR_MS);
  const recent = tenures.filter((t) => t.end >= fiveYearsAgo);
  const jobsLast5y = new Set(recent.map((t, i) => t.company || `#${i}`)).size;

  // Promotions: a higher level than the previous role, including within a company.
  const levels = roles.map((s) => titleLevel(s.title)).filter((l) => l >= 0);
  let promotions = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i]! > levels[i - 1]!) promotions++;
  const progression: CareerMetrics["progression"] =
    levels.length < 2 ? "unclear" : promotions > 0 ? "upward" : "lateral";

  const current = tenures.find((t) => t.ongoing) ?? null;
  const distinctEmployers = new Set(rows.map((r, i) => companyKey(r.company) || `#${i}`)).size;

  return {
    employers: distinctEmployers,
    dated_employers: tenures.length,
    total_years: round1(totalYears),
    avg_tenure_years: tenures.length ? round1(totalYears / tenures.length) : 0,
    shortest_stint_years: finished.length ? round1(Math.min(...finished)) : null,
    current_tenure_years: current ? round1(years(current)) : null,
    jobs_last_5y: jobsLast5y,
    longest_gap_months: Math.round(longestGap),
    total_gap_months: Math.round(totalGap),
    promotions,
    progression,
    skill_recency_years:
      opts?.skillRecencyYears === null || opts?.skillRecencyYears === undefined
        ? null
        : round1(opts.skillRecencyYears),
  };
}

export type CareerAssessment = { score: number; flags: string[]; notes: string[] };

/**
 * Turn the metrics into a 0-100 career-quality score. Penalties are explicit and
 * capped; a CV with no dates is scored neutrally (60) rather than punished.
 */
export function careerScore(m: CareerMetrics): CareerAssessment {
  const flags: string[] = [];
  const notes: string[] = [];

  if (m.dated_employers === 0) {
    return {
      score: 60,
      flags: ["Employment dates not readable from the CV — career quality could not be measured"],
      notes: ["Scored neutrally (60) because no dated roles were found."],
    };
  }

  let score = 100;
  const cut = (points: number, why: string) => {
    score -= points;
    notes.push(`-${points} · ${why}`);
  };

  if (m.avg_tenure_years < 1.5) {
    cut(25, `average tenure ${m.avg_tenure_years} yrs`);
    flags.push(
      `Short average tenure (${m.avg_tenure_years} yrs across ${m.dated_employers} employers)`,
    );
  } else if (m.avg_tenure_years < 2.5) {
    cut(10, `average tenure ${m.avg_tenure_years} yrs`);
  } else {
    notes.push(`Stable: ${m.avg_tenure_years} yrs average tenure.`);
  }

  if (m.shortest_stint_years !== null && m.shortest_stint_years < 0.75) {
    cut(8, `shortest stint ${m.shortest_stint_years} yrs`);
    flags.push(`A role shorter than 9 months (${m.shortest_stint_years} yrs)`);
  }

  if (m.jobs_last_5y > 3) {
    cut(12, `${m.jobs_last_5y} employers in the last 5 years`);
    flags.push(`${m.jobs_last_5y} employers in the last 5 years`);
  }

  if (m.longest_gap_months > 12) {
    cut(14, `${m.longest_gap_months}-month break between roles`);
    flags.push(`Unexplained break of ${m.longest_gap_months} months — ask, do not assume`);
  } else if (m.longest_gap_months > 6) {
    cut(8, `${m.longest_gap_months}-month break between roles`);
    flags.push(`Break of ${m.longest_gap_months} months between roles`);
  }

  if (m.progression === "upward") {
    score += 8;
    notes.push(`+8 · ${m.promotions} step-up${m.promotions === 1 ? "" : "s"} in title level`);
  } else if (m.progression === "lateral" && m.total_years >= 6) {
    cut(12, "no title progression across 6+ years");
    flags.push("No visible title progression despite 6+ years of experience");
  }

  if (m.skill_recency_years !== null && m.skill_recency_years > 3) {
    cut(10, `core requisition skills last used ~${m.skill_recency_years} yrs ago`);
    flags.push(`Core skills last used about ${m.skill_recency_years} years ago`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), flags, notes };
}
