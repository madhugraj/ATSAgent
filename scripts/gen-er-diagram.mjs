/**
 * Generate docs/er-diagram.md from drizzle/schema.ts.
 *
 * Usage: node scripts/gen-er-diagram.mjs
 * The schema file remains the source of truth; re-run after any schema change
 * and commit the refreshed diagram.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "drizzle/schema.ts"), "utf8");

/** snake table name -> documentation domain */
const DOMAINS = {
  users: "Identity & access",
  sessions: "Identity & access",
  user_roles: "Identity & access",
  platform_admins: "Identity & access",
  audit_log: "Identity & access",
  organizations: "Organisations & masters",
  org_members: "Organisations & masters",
  org_agreements: "Organisations & masters",
  org_pool_shares: "Organisations & masters",
  org_linkedin_connections: "Organisations & masters",
  departments: "Organisations & masters",
  master_items: "Organisations & masters",
  product_catalogue_commercials: "Organisations & masters",
  requisitions: "Requisitions & job content",
  job_descriptions: "Requisitions & job content",
  content_templates: "Requisitions & job content",
  candidates: "Candidates & pipeline",
  applications: "Candidates & pipeline",
  stage_events: "Candidates & pipeline",
  match_scores: "Candidates & pipeline",
  social_profiles: "Candidates & pipeline",
  candidate_verifications: "Candidates & pipeline",
  candidate_assessments: "Candidates & pipeline",
  candidate_notes: "Candidates & pipeline",
  candidate_referrals: "Candidates & pipeline",
  candidate_ownership_events: "Candidates & pipeline",
  talent_requests: "Candidates & pipeline",
  talent_request_suggestions: "Candidates & pipeline",
  evaluations: "Candidates & pipeline",
  screening_kits: "Screening & interviews",
  screening_runs: "Screening & interviews",
  screening_prep_jobs: "Screening & interviews",
  screening_calls: "Screening & interviews",
  phone_screening_settings: "Screening & interviews",
  interviews: "Screening & interviews",
  ai_interviews: "Screening & interviews",
  offers: "Offers & onboarding",
  onboarding_documents: "Offers & onboarding",
  hr_incentive_schemes: "Offers & onboarding",
  capture_events: "Sourcing & integrations",
  inbox_messages: "Sourcing & integrations",
  source_integrations: "Sourcing & integrations",
  integration_credentials: "Sourcing & integrations",
  skill_nodes: "Intelligence",
  skill_edges: "Intelligence",
  skill_evidence: "Intelligence",
  ontology_snapshots: "Intelligence",
  comp_knowledge: "Intelligence",
  salary_benchmarks: "Intelligence",
  copilot_messages: "Intelligence",
  email_outbox: "Communications & AI settings",
  email_settings: "Communications & AI settings",
  ai_settings: "Communications & AI settings",
  ai_provider_credentials: "Communications & AI settings",
  ai_usage_events: "Communications & AI settings",
};
const DOMAIN_ORDER = [...new Set(Object.values(DOMAINS))];

const tables = new Map(); // snake -> { symbol, cols: Map(sym -> {col,type,pk,uk,notNull,fk}), composites: [] }
const symToTable = new Map(); // drizzle symbol -> snake

const analyseColumn = (col, defn) => {
  const ref = defn.match(/\.references\(\(\) => (\w+)\.(\w+)/);
  return {
    col: col.col,
    type: col.type,
    pk: /\.primaryKey\(\)/.test(defn),
    notNull: /\.notNull\(\)/.test(defn) || /\.primaryKey\(\)/.test(defn),
    uk: false,
    fk: ref
      ? {
          tableSym: ref[1],
          onDelete: (defn.match(/onDelete: "(\w+)"/) ?? [])[1] ?? "no action",
        }
      : null,
  };
};

// One chunk per `export const`, so each contains its full table definition.
const chunks = src.split(/^export const /m).slice(1);
for (const chunk of chunks) {
  const head = chunk.match(/^(\w+) = pgTable\(\s*"(\w+)"/s);
  if (!head) continue;
  const symbol = head[1];
  const table = head[2];
  const cols = new Map();

  const lines = chunk.split("\n");
  let current = null;
  let buffer = "";
  let inObject = false;
  let colIndent = 0; // 4 when the `{` sits on its own line, 2 when inline
  const flush = () => {
    if (current) cols.set(current.sym, analyseColumn(current, buffer));
    current = null;
    buffer = "";
  };
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)[1].length;
    if (!inObject) {
      // Object opens either as a bare `  {` line or inline after pgTable("name", {.
      if (/\{\s*$/.test(line) && line.includes("pgTable(")) inObject = true;
      else if (/^ {2}\{$/.test(line)) inObject = true;
      continue;
    }
    const colOpen = line.match(/^(\s+)(\w+): (\w+)\("([^"]+)"/);
    if (colOpen && (colIndent === 0 || colOpen[1].length === colIndent)) {
      flush();
      if (colIndent === 0) colIndent = colOpen[1].length;
      current = { sym: colOpen[2], type: colOpen[3], col: colOpen[4] };
      buffer = line.trim();
    } else if (current && indent > colIndent) {
      buffer += " " + line.trim();
    } else if (colIndent !== 0 && /^\s*\}/.test(line) && indent === colIndent - 2) {
      flush();
      inObject = false;
    } else if (current) {
      flush();
    }
  }
  flush();

  tables.set(table, { symbol, cols, composites: [] });
  symToTable.set(symbol, table);

  // Index/constraint section — everything after `(t) =>`.
  const tOff = chunk.indexOf("(t) =>");
  if (tOff === -1) continue;
  const idxText = chunk.slice(tOff);
  for (const m of idxText.matchAll(/uniqueIndex\("[^"]+"\)\.on\(t\.(\w+)(?:,\s*t\.(\w+))?\)/g)) {
    if (m[2]) {
      tables.get(table).composites.push(`${m[1]}+${m[2]}`);
    } else {
      const c = cols.get(m[1]);
      if (c) c.uk = true;
    }
  }
  for (const m of idxText.matchAll(/primaryKey\(\{\s*columns:\s*\[([^\]]+)\]/g)) {
    for (const s of m[1].matchAll(/t\.(\w+)/g)) {
      const c = cols.get(s[1]);
      if (c) {
        c.pk = true;
        c.notNull = true;
      }
    }
  }
}

// FK edges with cardinality from nullability.
const edges = [];
for (const [table, def] of tables) {
  for (const c of def.cols.values()) {
    if (!c.fk) continue;
    const target = symToTable.get(c.fk.tableSym);
    if (!target) continue;
    edges.push({
      from: table,
      to: target,
      col: c.col,
      notNull: c.notNull,
      onDelete: c.fk.onDelete,
    });
  }
}

const merType = (t) => (t === "timestamp" ? "timestamptz" : t);
function entityBlock(table) {
  const def = tables.get(table);
  const lines = [`  ${table} {`];
  for (const c of def.cols.values()) {
    const keys = [c.pk ? "PK" : "", c.fk ? "FK" : "", c.uk ? "UK" : ""].filter(Boolean).join(",");
    const note = !c.notNull && !c.fk ? ' "nullable"' : "";
    lines.push(`    ${merType(c.type)} ${c.col}${keys ? ` ${keys}` : ""}${note}`);
  }
  lines.push("  }");
  return lines.join("\n");
}
const edgeLine = (e) =>
  `  ${e.from} ${e.notNull ? "}o--||" : "}o--o|"} ${e.to} : "${e.col}${e.onDelete !== "no action" ? ` · ${e.onDelete}` : ""}"`;

let md = `# ATSIQ — Entity-Relationship Diagram

> **Generated file — do not edit by hand.** Source of truth: \`drizzle/schema.ts\`.
> Regenerate after any schema change: \`node scripts/gen-er-diagram.mjs\`.
>
> Conventions: attribute keys — \`PK\` primary key, \`FK\` foreign key, \`UK\` unique.
> Unmarked single columns are nullable (noted explicitly). Relationship labels name
> the foreign-key column and call out non-default delete behaviour (e.g. \`cascade\`).
> A domain diagram shows that domain's tables in full; references into other domains
> point at a stub entity that is drawn complete in its own domain.

${tables.size} tables across ${DOMAIN_ORDER.length} domains.

`;

for (const domain of DOMAIN_ORDER) {
  const names = [...tables.keys()].filter((t) => DOMAINS[t] === domain);
  const inDomain = new Set(names);
  md += `## ${domain}\n\n`;
  md += `${names.map((n) => `\`${n}\``).join(", ")}\n\n`;
  md += "```mermaid\nerDiagram\n";
  for (const t of names) md += entityBlock(t) + "\n";
  const domainEdges = edges.filter((e) => inDomain.has(e.from));
  if (domainEdges.length) md += "\n" + domainEdges.map(edgeLine).join("\n") + "\n";
  md += "```\n\n";
}

md += "## All foreign-key relationships\n\n";
md += "| From (child) | Column | To (parent) | ON DELETE |\n|---|---|---|---|\n";
for (const e of [...edges].sort(
  (a, b) => a.from.localeCompare(b.from) || a.col.localeCompare(b.col),
)) {
  md += `| \`${e.from}\` | \`${e.col}\` | \`${e.to}\` | ${e.onDelete} |\n`;
}

md += "\n## Table inventory\n\n";
md += "| Table | Domain | Columns | Unique constraints |\n|---|---|---|---|\n";
for (const [table, def] of [...tables.entries()].sort()) {
  const uniques = [
    ...def.composites.map((c) => `(${c})`),
    ...[...def.cols.values()].filter((c) => c.uk).map((c) => `(${c.col})`),
  ];
  md += `| \`${table}\` | ${DOMAINS[table] ?? "—"} | ${def.cols.size} | ${uniques.join(", ") || "—"} |\n`;
}

const out = join(root, "docs", "er-diagram.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md);
console.log(`Wrote ${out}: ${tables.size} tables, ${edges.length} FK relationships.`);
