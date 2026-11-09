/**
 * Organisation ontology: domain → capability families → skills → roles, and
 * the roles that are emerging from combinations of established ones (backend +
 * data science → AI engineer; clinical + data → clinical data analyst).
 *
 * Pure and deterministic. Domain seed packs give a new organisation a sensible
 * starting map; everything else is learned from its own requisitions (titles
 * and must-have / good-to-have skills, over time) and its candidate pool
 * (supply). A role is "emerging" when requisitions keep asking for a skill
 * bundle that no single established role covers but two of them do together.
 * Names come from the real job titles seen; a person confirms a role into job
 * architecture (master data), which marks it established.
 */

export type DomainKey = "tech" | "healthcare" | "manufacturing" | "bfsi";
type FamilySeed = { name: string; color: string; match: RegExp };
type RoleSeed = { id: string; name: string; skills: string[] };
type DomainPack = { key: DomainKey; name: string; families: FamilySeed[]; roles: RoleSeed[] };

const TECH_FAMILIES: FamilySeed[] = [
  {
    name: "Backend",
    color: "#6c8cff",
    match:
      /(java|spring|node|golang|\bgo\b|\.net|c#|django|flask|fastapi|rest|api|microservice|backend|php|ruby|kotlin)/,
  },
  {
    name: "Data science",
    color: "#c06cff",
    match:
      /(statistic|pandas|numpy|scikit|sklearn|data scien|feature eng|regression|r programming|a\/b test)/,
  },
  {
    name: "AI / ML",
    color: "#ff6cb8",
    match:
      /(machine learning|deep learning|pytorch|tensorflow|llm|genai|generative|rag|prompt|nlp|computer vision|vector|langchain|mlops|hugging ?face)/,
  },
  {
    name: "Frontend",
    color: "#4fd1c5",
    match:
      /(react|angular|vue|typescript|javascript|next\.?js|css|html|frontend|tailwind|accessibility|redux)/,
  },
  {
    name: "Cloud & DevOps",
    color: "#f6ad55",
    match:
      /(aws|azure|gcp|google cloud|kubernetes|docker|terraform|devops|ci\/cd|jenkins|helm|observability|sre|linux|ansible)/,
  },
  {
    name: "Data",
    color: "#68d391",
    match:
      /(sql|postgres|mysql|mongo|spark|dbt|airflow|snowflake|etl|warehouse|kafka|databricks|bigquery|redshift)/,
  },
  {
    name: "Quality",
    color: "#a0aec0",
    match: /(qa|testing|selenium|cypress|playwright|test automation)/,
  },
];
const BUSINESS_FAMILIES: FamilySeed[] = [
  {
    name: "Sales & marketing",
    color: "#f687b3",
    match:
      /(sales|business development|account management|crm|salesforce|marketing|seo|campaign|brand)/,
  },
  {
    name: "People & finance",
    color: "#90cdf4",
    match: /(recruit|payroll|hris|talent|compensation|finance|accounting|audit|tax|fp&a)/,
  },
];

const PACKS: Record<DomainKey, DomainPack> = {
  tech: {
    key: "tech",
    name: "Technology",
    families: [...TECH_FAMILIES, ...BUSINESS_FAMILIES],
    roles: [
      {
        id: "backend",
        name: "Backend engineer",
        skills: ["java", "spring", "node", "rest", "microservice", "sql", "api"],
      },
      {
        id: "data-scientist",
        name: "Data scientist",
        skills: ["python", "statistic", "pandas", "scikit", "machine learning", "feature eng"],
      },
      {
        id: "frontend",
        name: "Frontend engineer",
        skills: ["react", "typescript", "javascript", "css", "next", "html"],
      },
      {
        id: "devops",
        name: "DevOps engineer",
        skills: ["aws", "kubernetes", "docker", "terraform", "ci/cd", "linux"],
      },
      {
        id: "data-engineer",
        name: "Data engineer",
        skills: ["sql", "spark", "airflow", "dbt", "snowflake", "etl", "kafka"],
      },
      {
        id: "qa",
        name: "QA engineer",
        skills: ["testing", "selenium", "cypress", "playwright", "qa"],
      },
    ],
  },
  healthcare: {
    key: "healthcare",
    name: "Healthcare",
    families: [
      {
        name: "Clinical",
        color: "#ff7a8a",
        match:
          /(patient|triage|clinical protocol|pharmacolog|nursing|charting|bedside|icu|ward|phlebotomy)/,
      },
      {
        name: "Health informatics",
        color: "#6c8cff",
        match: /(hl7|fhir|ehr|emr|epic|cerner|clinical data|interoperab|health informatics)/,
      },
      {
        name: "Regulatory & quality",
        color: "#f6ad55",
        match:
          /(hipaa|gcp|gdp|nabh|jci|audit|quality system|clinical trial|pharmacovigilance|compliance)/,
      },
      {
        name: "Revenue cycle",
        color: "#68d391",
        match: /(icd|cpt|coding|billing|claim|denial|revenue cycle|insurance)/,
      },
      {
        name: "Digital care",
        color: "#4fd1c5",
        match: /(telehealth|telemedicine|remote monitoring|care pathway|patient app|virtual care)/,
      },
      ...TECH_FAMILIES.filter((f) => ["Data science", "AI / ML", "Data"].includes(f.name)),
    ],
    roles: [
      {
        id: "nurse",
        name: "Clinical nurse",
        skills: ["patient", "triage", "clinical protocol", "charting", "nursing"],
      },
      {
        id: "informatics",
        name: "Health informatics analyst",
        skills: ["hl7", "fhir", "ehr", "clinical data", "sql"],
      },
      { id: "coder", name: "Medical coder", skills: ["icd", "cpt", "coding", "billing", "claim"] },
      {
        id: "regulatory",
        name: "Clinical QA / regulatory",
        skills: ["hipaa", "gcp", "audit", "quality system", "compliance"],
      },
      {
        id: "data-analyst",
        name: "Data analyst",
        skills: ["python", "statistic", "sql", "dashboard", "power bi", "tableau"],
      },
    ],
  },
  manufacturing: {
    key: "manufacturing",
    name: "Manufacturing",
    families: [
      {
        name: "OT / automation",
        color: "#f6ad55",
        match: /(plc|scada|hmi|robot|industrial network|dcs|automation|siemens|allen.?bradley)/,
      },
      {
        name: "Quality",
        color: "#68d391",
        match: /(six sigma|gmp|spc|root cause|iso 9001|quality|fmea|ppap|8d)/,
      },
      {
        name: "Supply chain",
        color: "#4fd1c5",
        match: /(planning|inventory|sap|erp|procurement|logistics|supply chain|mrp)/,
      },
      {
        name: "Maintenance",
        color: "#ff7a8a",
        match: /(maintenance|vibration|cmms|reliability|tpm|predictive)/,
      },
      {
        name: "Data & IIoT",
        color: "#c06cff",
        match: /(iot|iiot|edge|time.?series|sensor|historian|python|dashboard)/,
      },
      {
        name: "Process engineering",
        color: "#6c8cff",
        match: /(lean|process design|cad|solidworks|simulation|kaizen|value stream)/,
      },
    ],
    roles: [
      {
        id: "automation",
        name: "Automation engineer",
        skills: ["plc", "scada", "hmi", "industrial network", "automation"],
      },
      {
        id: "quality",
        name: "Quality engineer",
        skills: ["six sigma", "spc", "root cause", "iso 9001", "fmea"],
      },
      {
        id: "maintenance",
        name: "Maintenance engineer",
        skills: ["maintenance", "cmms", "reliability", "vibration"],
      },
      {
        id: "planner",
        name: "Supply chain planner",
        skills: ["planning", "inventory", "sap", "procurement"],
      },
      {
        id: "data-analyst",
        name: "Data analyst",
        skills: ["python", "dashboard", "time-series", "sql", "statistic"],
      },
    ],
  },
  bfsi: {
    key: "bfsi",
    name: "Banking & financial services",
    families: [
      {
        name: "Risk & compliance",
        color: "#ff7a8a",
        match: /(risk|kyc|aml|basel|compliance|fraud|credit)/,
      },
      {
        name: "Core banking",
        color: "#6c8cff",
        match: /(core banking|finacle|temenos|payments|swift|cards|lending)/,
      },
      ...TECH_FAMILIES.filter((f) =>
        ["Backend", "Data science", "AI / ML", "Data", "Cloud & DevOps"].includes(f.name),
      ),
    ],
    roles: [
      {
        id: "risk-analyst",
        name: "Risk analyst",
        skills: ["risk", "credit", "basel", "statistic", "excel"],
      },
      {
        id: "compliance",
        name: "Compliance officer",
        skills: ["kyc", "aml", "compliance", "audit"],
      },
      {
        id: "backend",
        name: "Backend engineer",
        skills: ["java", "spring", "rest", "microservice", "sql"],
      },
      {
        id: "data-scientist",
        name: "Data scientist",
        skills: ["python", "statistic", "machine learning", "pandas"],
      },
    ],
  },
};

const GENERAL = { name: "General", color: "#9aa3c7" };

/** Industry text (organisation profile) → domain pack; technology when unknown. */
export function domainOf(industry: string | null | undefined): DomainKey {
  const s = (industry ?? "").toLowerCase();
  if (/(health|hospital|clinic|pharma|medical|life science|biotech)/.test(s)) return "healthcare";
  if (
    /(manufactur|industrial|automotive|factory|plant|fmcg|chemical|steel|engineering goods)/.test(s)
  )
    return "manufacturing";
  if (/(bank|financ|insurance|bfsi|fintech|lending|nbfc)/.test(s)) return "bfsi";
  return "tech";
}

/* ------------------------------------------------------------------ inputs and outputs */

export type OntologyRequisition = { id: string; title: string; skills: string[]; createdAt: Date };
export type OntologyCandidate = { skills: string[]; createdAt: Date };
export type RoleStatus = "signal" | "emerging" | "established";

export type OrgFamily = {
  name: string;
  color: string;
  skills: { name: string; demand: number; supply: number }[];
};
export type OrgRole = {
  id: string;
  name: string;
  skills: string[];
  demand: number;
  supply: number;
  source: "seed" | "learned";
};
export type EmergingRole = {
  id: string;
  name: string;
  parents: string[];
  skills: string[];
  titles: string[];
  /** Month index (into `months`) of the first signal, of becoming emerging and established. */
  signal: number;
  emerging: number | null;
  established: number | null;
  status: RoleStatus;
  confirmed: boolean;
  /** Cumulative requisitions asking for this bundle, per month. */
  demand: number[];
  supply: number;
  requisitions: number;
};
export type OrgOntology = {
  domain: { key: DomainKey; name: string };
  months: string[];
  families: OrgFamily[];
  roles: OrgRole[];
  emerging: EmergingRole[];
  stats: { requisitions: number; candidates: number; skills: number };
};

/* ------------------------------------------------------------------ helpers */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const hit = (skill: string, keyword: string) => norm(skill).includes(keyword);
/** Share of a bundle's skills that a role's keywords cover. */
function coverage(bundle: string[], role: { skills: string[] }) {
  if (!bundle.length) return 0;
  return bundle.filter((s) => role.skills.some((k) => hit(s, k))).length / bundle.length;
}
const titleKey = (t: string) =>
  norm(t)
    .replace(
      /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|associate|trainee|intern|head of|i{1,3}|[0-9]+)\b/g,
      " ",
    )
    .replace(/[^a-z/& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const ACRONYM: Record<string, string> = {
  ai: "AI",
  ml: "ML",
  qa: "QA",
  sre: "SRE",
  iot: "IoT",
  iiot: "IIoT",
  ui: "UI",
  mlops: "MLOps",
  devops: "DevOps",
  genai: "GenAI",
  llm: "LLM",
  ux: "UX",
  hr: "HR",
  it: "IT",
  bi: "BI",
  ot: "OT",
};
const pretty = (t: string) =>
  t.replace(/\b\w+/g, (w) => ACRONYM[w.toLowerCase()] ?? `${w[0]!.toUpperCase()}${w.slice(1)}`);
const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export const ONTOLOGY_MONTHS = 18;
const EMERGING_AT = 3; // requisitions asking for the bundle
const ESTABLISHED_AT = 6;
const ESTABLISHED_SPAN = 3; // months between first signal and established

/**
 * Two roles that together explain a bundle: the best role, plus the role that
 * best explains what the first leaves over. Both must bring at least two
 * skills, and together cover at least 60% of the bundle — the rest is what is
 * genuinely new about the role (LLMs and RAG for an AI engineer).
 */
function hybridSplit(
  bundle: string[],
  roles: { id: string; skills: string[] }[],
): [string, string] | null {
  const ranked = roles.map((r) => ({ r, c: coverage(bundle, r) })).sort((a, b) => b.c - a.c);
  const a = ranked[0];
  if (!a || a.c === 0) return null;
  const rest = bundle.filter((s) => !a.r.skills.some((k) => hit(s, k)));
  if (rest.length < 2) return null;
  const b = roles
    .filter((r) => r.id !== a.r.id)
    .map((r) => ({ r, n: rest.filter((s) => r.skills.some((k) => hit(s, k))).length }))
    .sort((x, y) => y.n - x.n)[0];
  if (!b || b.n < 2) return null;
  const covered = bundle.length - rest.length + b.n;
  return covered / bundle.length >= 0.6 ? [a.r.id, b.r.id] : null;
}

/* ------------------------------------------------------------------ build */

export function buildOrgOntology(input: {
  industry: string | null;
  requisitions: OntologyRequisition[];
  candidates: OntologyCandidate[];
  /** Role titles a person already confirmed into job architecture (master data). */
  confirmedTitles: string[];
  now?: Date;
}): OrgOntology {
  const pack = PACKS[domainOf(input.industry)];
  const now = input.now ?? new Date();
  const months: string[] = [];
  for (let i = ONTOLOGY_MONTHS - 1; i >= 0; i--) {
    months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  const monthIdx = (d: Date) => {
    const i = months.indexOf(monthKey(d));
    return i === -1 ? (d < new Date(`${months[0]}-01T00:00:00Z`) ? 0 : months.length - 1) : i;
  };
  const confirmed = new Set(input.confirmedTitles.map(titleKey));
  const familyOf = (skill: string) =>
    pack.families.find((f) => f.match.test(norm(skill))) ?? GENERAL;
  const covers = (cand: OntologyCandidate, bundle: string[]) =>
    bundle.length > 0 &&
    bundle.filter((s) =>
      cand.skills.some((c) => norm(c) === norm(s) || hit(c, norm(s)) || hit(s, norm(c))),
    ).length /
      bundle.length >=
      0.6;

  // requisitions grouped by normalised title → the skill bundle the organisation asks for under it
  type Group = {
    titles: Map<string, number>;
    reqs: OntologyRequisition[];
    skills: Map<string, number>;
  };
  const groups = new Map<string, Group>();
  for (const r of input.requisitions) {
    const k = titleKey(r.title);
    if (!k) continue;
    const g: Group = groups.get(k) ?? { titles: new Map(), reqs: [], skills: new Map() };
    g.titles.set(r.title.trim(), (g.titles.get(r.title.trim()) ?? 0) + 1);
    g.reqs.push(r);
    for (const s of new Set(r.skills.map((x) => x.trim()).filter(Boolean)))
      g.skills.set(s, (g.skills.get(s) ?? 0) + 1);
    groups.set(k, g);
  }
  const bundleOf = (g: { reqs: unknown[]; skills: Map<string, number> }) =>
    [...g.skills.entries()]
      .filter(([, n]) => n / g.reqs.length >= 0.4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([s]) => s);

  type Known = {
    id: string;
    name: string;
    skills: string[];
    source: "seed" | "learned";
    demand: number;
  };
  const known: Known[] = pack.roles.map((r) => ({ ...r, source: "seed", demand: 0 }));
  const emerging: EmergingRole[] = [];
  const pending: { key: string; g: Group; bundle: string[] }[] = [];

  // pass 1: groups one established role explains stay with it; anything a
  // second role explains the remainder of is a hybrid and goes to pass 2
  for (const [key, g] of groups) {
    const bundle = bundleOf(g);
    if (!bundle.length) continue;
    const sameName = known.find((r) => titleKey(r.name) === key);
    if (sameName) {
      sameName.demand += g.reqs.length;
      continue;
    }
    const split = hybridSplit(bundle, known);
    const best = known.map((r) => ({ r, c: coverage(bundle, r) })).sort((a, b) => b.c - a.c)[0];
    if (!split && best && best.c >= 0.6) {
      best.r.demand += g.reqs.length;
      continue;
    }
    pending.push({ key, g, bundle });
  }
  // pass 2 (twice, so a new role can be born from another new one): hybrids of two roles
  for (let round = 0; round < 2; round++) {
    for (const p of [...pending]) {
      const pool: Known[] = [
        ...known,
        ...emerging.map((e) => ({
          id: e.id,
          name: e.name,
          skills: e.skills.map(norm),
          source: "learned" as const,
          demand: 0,
        })),
      ];
      const split = hybridSplit(p.bundle, pool);
      const best = pool
        .map((r) => ({ r, c: coverage(p.bundle, r) }))
        .filter((x) => x.c >= 0.2)
        .sort((a, b) => b.c - a.c)[0];
      const parents = split ? split : best && round === 1 ? [best.r.id] : null;
      if (!parents) continue;
      pending.splice(pending.indexOf(p), 1);
      const titles = [...p.g.titles.entries()].sort((x, y) => y[1] - x[1]).map(([t]) => t);
      const perMonth = new Array<number>(months.length).fill(0);
      for (const r of p.g.reqs) perMonth[monthIdx(r.createdAt)]! += 1;
      const demand: number[] = [];
      perMonth.reduce((acc, n, i) => ((demand[i] = acc + n), acc + n), 0);
      const signal = demand.findIndex((n) => n > 0);
      const emergingAt = demand.findIndex((n) => n >= EMERGING_AT);
      let establishedAt = demand.findIndex(
        (n, i) => n >= ESTABLISHED_AT && i - signal >= ESTABLISHED_SPAN,
      );
      const isConfirmed = confirmed.has(p.key);
      if (isConfirmed && establishedAt === -1) establishedAt = months.length - 1;
      const status: RoleStatus =
        establishedAt !== -1 ? "established" : emergingAt !== -1 ? "emerging" : "signal";
      emerging.push({
        id: `new-${p.key.replace(/[^a-z]+/g, "-")}`,
        name: pretty(p.key),
        parents,
        skills: p.bundle,
        titles: titles.slice(0, 4),
        signal: Math.max(0, signal),
        emerging: emergingAt === -1 ? null : emergingAt,
        established: establishedAt === -1 ? null : establishedAt,
        status,
        confirmed: isConfirmed,
        demand,
        supply: input.candidates.filter((c) => covers(c, p.bundle)).length,
        requisitions: p.g.reqs.length,
      });
    }
  }

  // skills by family, with demand (requisitions) and supply (candidates)
  const skillDemand = new Map<string, number>();
  for (const r of input.requisitions)
    for (const s of new Set(r.skills.map((x) => x.trim()).filter(Boolean)))
      skillDemand.set(s, (skillDemand.get(s) ?? 0) + 1);
  const skillSupply = new Map<string, number>();
  for (const c of input.candidates)
    for (const s of new Set(c.skills.map((x) => x.trim()).filter(Boolean)))
      skillSupply.set(s, (skillSupply.get(s) ?? 0) + 1);
  const byLower = new Map<string, string>();
  for (const s of [...skillDemand.keys(), ...skillSupply.keys()])
    if (!byLower.has(norm(s))) byLower.set(norm(s), s);
  const famMap = new Map<string, OrgFamily>();
  for (const f of pack.families) famMap.set(f.name, { name: f.name, color: f.color, skills: [] });
  for (const [, s] of byLower) {
    const f = familyOf(s);
    const fam = famMap.get(f.name) ?? { name: f.name, color: f.color, skills: [] };
    fam.skills.push({ name: s, demand: skillDemand.get(s) ?? 0, supply: skillSupply.get(s) ?? 0 });
    famMap.set(f.name, fam);
  }
  // seed role keywords keep an empty family visible with its typical skills
  for (const r of pack.roles)
    for (const k of r.skills) {
      const f = familyOf(k);
      const fam = famMap.get(f.name);
      if (fam && fam.skills.length < 3 && !fam.skills.some((x) => norm(x.name).includes(k)))
        fam.skills.push({ name: pretty(k), demand: 0, supply: 0 });
    }
  const ranked = [...famMap.values()]
    .map((f) => ({
      ...f,
      skills: f.skills.sort((a, b) => b.demand + b.supply - (a.demand + a.supply)).slice(0, 8),
    }))
    .filter((f) => f.skills.length > 0);
  // families with real evidence first; seed-only families only fill a sparse map
  const real = ranked.filter((f) => f.skills.some((x) => x.demand + x.supply > 0));
  const families = (real.length >= 4 ? real : [...real, ...ranked.filter((f) => !real.includes(f))])
    .sort((a, b) => b.skills.length - a.skills.length)
    .slice(0, 8);

  const roles: OrgRole[] = known.map((r) => ({
    id: r.id,
    name: r.name,
    skills: r.skills,
    demand: r.demand,
    supply: input.candidates.filter((c) => coverage(c.skills, r) >= 0.4).length,
    source: r.source,
  }));

  return {
    domain: { key: pack.key, name: pack.name },
    months,
    families,
    roles,
    emerging: emerging.sort((a, b) => a.signal - b.signal),
    stats: {
      requisitions: input.requisitions.length,
      candidates: input.candidates.length,
      skills: byLower.size,
    },
  };
}

/** Skills shown as nodes for a role: the family skills its keywords match. */
export function roleSkillNodes(role: { skills: string[] }, families: OrgFamily[]): string[] {
  const all = families.flatMap((f) => f.skills.map((s) => s.name));
  return all.filter((s) => role.skills.some((k) => hit(s, norm(k)) || hit(k, norm(s))));
}
