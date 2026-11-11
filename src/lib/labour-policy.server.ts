/**
 * Labour law & policy (docs/labour-policy-agent-plan.md, L0–L2).
 *
 * - Sources: official sites per pay zone, from an approved list. Only a source's
 *   own URL is ever fetched (`safeFetchText`), never a link off it, never a search.
 * - Reads: hashed; an unchanged page costs no AI call. A read under 12 hours old is
 *   reused (polite to the publisher, and repeatable in rehearsals).
 * - Findings: the agent records each change with the exact quote from the page it
 *   read — a quote not on that page is refused — and asks the HR head. Only an
 *   approved finding becomes one of the organisation's rules, which every agent
 *   reads through the organisation context.
 * Every query carries the organisation predicate; every decision is audited.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";

import {
  payZones,
  policyFindings,
  policyReads,
  policySources,
  POLICY_AREAS,
  type PolicyArea,
} from "../../drizzle/schema";
import { db } from "../server/db";
import { writeAudit } from "../server/audit";

export type PolicyActor = { orgId: string; userId: string; memberEmail: string };

/** Who decides findings and the source list. */
const DECIDERS = ["hr_head", "president_cbo"] as const;

async function assertDecider(actor: PolicyActor, what: string): Promise<void> {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(
    actor.userId,
    actor.orgId,
    [...DECIDERS],
    `Only the HR head, the CBO or an owner can ${what}.`,
  );
}

/* --------------------------------------------------------------- sources */

type Seed = { level: "global" | "regional" | "country"; label: string; url: string };

const EU = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

/** Official update pages per country (the organisation edits the list). */
export const SEED_SOURCES: Record<string, Seed[]> = {
  "*": [
    { level: "global", label: "ILO NATLEX — labour legislation", url: "https://natlex.ilo.org/" },
  ],
  EU: [
    {
      level: "regional",
      label: "EUR-Lex — Official Journal of the EU",
      url: "https://eur-lex.europa.eu/oj/direct-access.html",
    },
  ],
  IN: [
    {
      level: "country",
      label: "Ministry of Labour & Employment — what's new",
      url: "https://labour.gov.in/whatsnew",
    },
    { level: "country", label: "The Gazette of India", url: "https://egazette.gov.in/" },
    {
      level: "country",
      label: "EPFO — what's new",
      url: "https://www.epfindia.gov.in/site_en/WhatsNew.php",
    },
  ],
  GB: [
    {
      level: "country",
      label: "legislation.gov.uk — new legislation",
      url: "https://www.legislation.gov.uk/new",
    },
    {
      level: "country",
      label: "GOV.UK — employing people",
      url: "https://www.gov.uk/browse/employing-people",
    },
  ],
  US: [
    {
      level: "country",
      label: "US Department of Labor — news releases",
      url: "https://www.dol.gov/newsroom/releases",
    },
    { level: "country", label: "EEOC — newsroom", url: "https://www.eeoc.gov/newsroom" },
  ],
  IT: [
    {
      level: "country",
      label: "Ministero del Lavoro — notizie",
      url: "https://www.lavoro.gov.it/notizie",
    },
    { level: "country", label: "Gazzetta Ufficiale", url: "https://www.gazzettaufficiale.it/" },
  ],
  DE: [
    {
      level: "country",
      label: "BMAS — Pressemitteilungen",
      url: "https://www.bmas.de/DE/Service/Presse/Pressemitteilungen/pressemitteilungen.html",
    },
  ],
  FR: [
    {
      level: "country",
      label: "Ministère du Travail — actualités",
      url: "https://travail-emploi.gouv.fr/actualites",
    },
  ],
  ES: [
    {
      level: "country",
      label: "Ministerio de Trabajo — notas de prensa",
      url: "https://www.mites.gob.es/es/prensa/notas/index.htm",
    },
  ],
  PL: [
    {
      level: "country",
      label: "Ministerstwo Rodziny, Pracy — wiadomości",
      url: "https://www.gov.pl/web/rodzina/wiadomosci",
    },
  ],
  AE: [
    {
      level: "country",
      label: "MOHRE — news",
      url: "https://www.mohre.gov.ae/en/media-centre/news.aspx",
    },
  ],
  SG: [
    {
      level: "country",
      label: "Ministry of Manpower — newsroom",
      url: "https://www.mom.gov.sg/newsroom",
    },
  ],
  BR: [
    {
      level: "country",
      label: "Ministério do Trabalho — notícias",
      url: "https://www.gov.br/trabalho-e-emprego/pt-br/noticias-e-conteudo",
    },
  ],
};

/** The seed sources for a set of zones (pure; unit-tested). */
export function seedsFor(zones: { id: string; countries: string[] }[]) {
  const out: (Seed & { country: string | null; zoneId: string | null })[] = [];
  const add = (s: Seed, country: string | null, zoneId: string | null) => {
    if (!out.some((o) => o.url === s.url)) out.push({ ...s, country, zoneId });
  };
  for (const s of SEED_SOURCES["*"]!) add(s, null, null);
  for (const z of zones)
    for (const c of z.countries) {
      if (EU.has(c)) for (const s of SEED_SOURCES["EU"]!) add(s, null, null);
      for (const s of SEED_SOURCES[c] ?? []) add(s, c, z.id);
    }
  return out;
}

function hostOf(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Sources must be https.");
  return u.hostname.toLowerCase();
}

/** Seed the official sources for the organisation's pay zones (missing ones only). */
export async function seedSourcesCore(actor: PolicyActor): Promise<{ added: number }> {
  await assertDecider(actor, "change the policy sources");
  const zones = await db
    .select({ id: payZones.id, countries: payZones.countries })
    .from(payZones)
    .where(eq(payZones.orgId, actor.orgId));
  let added = 0;
  for (const s of seedsFor(zones)) {
    const rows = await db
      .insert(policySources)
      .values({
        orgId: actor.orgId,
        zoneId: s.zoneId,
        country: s.country,
        level: s.level,
        label: s.label,
        url: s.url,
        host: hostOf(s.url),
        seeded: true,
        addedBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning({ id: policySources.id });
    added += rows.length;
  }
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "policy_sources.seeded",
    entityType: "organization",
    entityId: actor.orgId,
    detail: { added },
  });
  return { added };
}

/** Add one source (HR head, CBO or owner) — the allow-list; audited. */
export async function addSourceCore(
  actor: PolicyActor,
  input: { url: string; label: string; level?: string; country?: string | null },
): Promise<{ id: string }> {
  await assertDecider(actor, "change the policy sources");
  const host = hostOf(input.url.trim());
  const label = input.label.trim();
  if (label.length < 3) throw new Error("Name the source.");
  const level = (input.level ?? "country") as string;
  if (!["global", "regional", "country", "state", "domain", "organisation"].includes(level))
    throw new Error("Unknown source level.");
  const [row] = await db
    .insert(policySources)
    .values({
      orgId: actor.orgId,
      country: input.country?.toUpperCase() ?? null,
      level,
      label: label.slice(0, 160),
      url: input.url.trim(),
      host,
      addedBy: actor.userId,
    })
    .onConflictDoNothing()
    .returning({ id: policySources.id });
  if (!row) throw new Error("That source is already on the list.");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: "policy_source.added",
    entityType: "policy_source",
    entityId: row.id,
    detail: { url: input.url.trim(), host, level },
  });
  return { id: row.id };
}

export async function setSourceActiveCore(
  actor: PolicyActor,
  input: { id: string; active: boolean },
): Promise<void> {
  await assertDecider(actor, "change the policy sources");
  const done = await db
    .update(policySources)
    .set({ active: input.active })
    .where(and(eq(policySources.id, input.id), eq(policySources.orgId, actor.orgId)))
    .returning({ id: policySources.id, url: policySources.url });
  if (!done.length) throw new Error("Source not found.");
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: input.active ? "policy_source.resumed" : "policy_source.paused",
    entityType: "policy_source",
    entityId: input.id,
    detail: { url: done[0]!.url },
  });
}

export async function listSources(orgId: string) {
  const sources = await db
    .select()
    .from(policySources)
    .where(eq(policySources.orgId, orgId))
    .orderBy(policySources.level, policySources.label);
  const reads = sources.length
    ? await db
        .select({
          sourceId: policyReads.sourceId,
          status: policyReads.status,
          fetchedAt: policyReads.fetchedAt,
          error: policyReads.error,
        })
        .from(policyReads)
        .where(
          and(
            eq(policyReads.orgId, orgId),
            inArray(
              policyReads.sourceId,
              sources.map((s) => s.id),
            ),
          ),
        )
        .orderBy(desc(policyReads.fetchedAt))
    : [];
  return sources.map((s) => {
    const last = reads.find((r) => r.sourceId === s.id) ?? null;
    return {
      id: s.id,
      label: s.label,
      url: s.url,
      level: s.level,
      country: s.country,
      active: s.active,
      seeded: s.seeded,
      lastRead: last
        ? { status: last.status, at: last.fetchedAt.toISOString(), error: last.error }
        : null,
    };
  });
}

/* ----------------------------------------------------------------- reads */

/** Lines of `next` not in `prev` (pure): what is new on the page. */
export function newLines(prev: string | null, next: string): string[] {
  const seen = new Set(
    (prev ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return next
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !seen.has(l));
}

const REUSE_MS = 12 * 3_600_000;

/**
 * Read one source: its own URL only, through the safe fetcher. Returns the new
 * lines since the last read (all lines on the first read), capped for the prompt.
 */
export async function readSourceCore(
  orgId: string,
  sourceId: string,
  opts: {
    agentRunId?: string | null;
    now?: Date;
    fetchText?: (url: string) => Promise<string>;
  } = {},
): Promise<{
  source: { id: string; label: string; url: string; country: string | null };
  status: "changed" | "unchanged" | "first" | "failed" | "recent";
  newText: string;
  error?: string;
}> {
  const now = opts.now ?? new Date();
  const [s] = await db
    .select()
    .from(policySources)
    .where(and(eq(policySources.id, sourceId), eq(policySources.orgId, orgId)))
    .limit(1);
  if (!s) throw new Error("Source not found.");
  if (!s.active) throw new Error("This source is paused.");
  const source = { id: s.id, label: s.label, url: s.url, country: s.country };
  const history = await db
    .select()
    .from(policyReads)
    .where(and(eq(policyReads.orgId, orgId), eq(policyReads.sourceId, s.id)))
    .orderBy(desc(policyReads.fetchedAt))
    .limit(5);
  const lastOk = history.find((h) => h.status !== "failed" && h.text != null) ?? null;
  // A fresh read is reused: no second fetch inside 12 hours.
  if (lastOk && now.getTime() - lastOk.fetchedAt.getTime() < REUSE_MS) {
    const before = history.find((h) => h !== lastOk && h.status !== "failed" && h.text != null);
    return {
      source,
      status: "recent",
      newText: newLines(before?.text ?? null, lastOk.text!)
        .join("\n")
        .slice(0, 20_000),
    };
  }
  let text: string;
  try {
    if (hostOf(s.url) !== s.host)
      throw new Error("The source's address no longer matches its host.");
    if (opts.fetchText) text = await opts.fetchText(s.url);
    else {
      const { safeFetchText } = await import("../server/safe-fetch");
      const { htmlToText } = await import("./org-context.server");
      const res = await safeFetchText(s.url, { timeoutMs: 15_000, maxBytes: 1_500_000, hops: 2 });
      if (new URL(res.finalUrl).hostname.toLowerCase() !== s.host)
        throw new Error("The page redirected off the source's own host.");
      text = /html/i.test(res.contentType) ? htmlToText(res.text) : res.text;
    }
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : "Read failed";
    await db.insert(policyReads).values({
      orgId,
      sourceId: s.id,
      status: "failed",
      error,
      fetchedAt: now,
      agentRunId: opts.agentRunId ?? null,
    });
    return { source, status: "failed", newText: "", error };
  }
  text = text.slice(0, 200_000);
  const hash = createHash("sha256").update(text).digest("hex");
  const status = !lastOk ? "first" : lastOk.hash === hash ? "unchanged" : "changed";
  await db.insert(policyReads).values({
    orgId,
    sourceId: s.id,
    status,
    hash,
    text,
    fetchedAt: now,
    agentRunId: opts.agentRunId ?? null,
  });
  return {
    source,
    status,
    newText:
      status === "unchanged"
        ? ""
        : newLines(lastOk?.text ?? null, text)
            .join("\n")
            .slice(0, 20_000),
  };
}

/* -------------------------------------------------------------- findings */

const squash = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Record one change the agent found. The quote must be on the page it last read
 * from that source; a finding with the same quote from the same source is not
 * recorded twice.
 */
export async function recordFindingCore(
  orgId: string,
  input: {
    sourceId: string;
    quote: string;
    area: PolicyArea;
    summary: string;
    rule: string;
    impact?: string | undefined;
    effectiveDate?: string | null | undefined;
  },
  opts: { agentRunId?: string | null } = {},
): Promise<{ ok: true; findingId: string } | { ok: false; error: string }> {
  if (!(POLICY_AREAS as readonly string[]).includes(input.area))
    return { ok: false, error: "Unknown area." };
  const [s] = await db
    .select()
    .from(policySources)
    .where(and(eq(policySources.id, input.sourceId), eq(policySources.orgId, orgId)))
    .limit(1);
  if (!s) return { ok: false, error: "Source not found." };
  const [read] = await db
    .select({ text: policyReads.text })
    .from(policyReads)
    .where(
      and(
        eq(policyReads.orgId, orgId),
        eq(policyReads.sourceId, s.id),
        inArray(policyReads.status, ["changed", "first", "unchanged"]),
      ),
    )
    .orderBy(desc(policyReads.fetchedAt))
    .limit(1);
  const quote = input.quote.trim();
  if (quote.length < 15)
    return { ok: false, error: "Quote the source's own words — at least a full phrase." };
  if (!read?.text || !squash(read.text).includes(squash(quote)))
    return {
      ok: false,
      error:
        "That quote is not on the page read from this source. Quote its exact words, or record nothing.",
    };
  // The zone this source belongs to (a country source covers that country's zones).
  const zone = s.zoneId
    ? s.zoneId
    : s.country
      ? ((
          await db
            .select({ id: payZones.id, countries: payZones.countries })
            .from(payZones)
            .where(eq(payZones.orgId, orgId))
        ).find((z) => z.countries.includes(s.country!))?.id ?? null)
      : null;
  const rows = await db
    .insert(policyFindings)
    .values({
      orgId,
      sourceId: s.id,
      zoneId: zone,
      url: s.url,
      quote: quote.slice(0, 2_000),
      area: input.area,
      summary: input.summary.trim().slice(0, 1_000),
      rule: input.rule.trim().slice(0, 1_000),
      impact: (input.impact ?? "").trim().slice(0, 1_500),
      effectiveDate: input.effectiveDate ?? null,
      agentRunId: opts.agentRunId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: policyFindings.id });
  if (!rows.length) return { ok: false, error: "This change is already recorded." };
  await writeAudit({
    actor: "agent:labour_policy",
    actorUserId: null,
    orgId,
    action: "policy_finding.recorded",
    entityType: "policy_finding",
    entityId: rows[0]!.id,
    detail: { sourceId: s.id, area: input.area, effectiveDate: input.effectiveDate ?? null },
  });
  return { ok: true, findingId: rows[0]!.id };
}

export async function findingFor(orgId: string, findingId: string) {
  const [f] = await db
    .select()
    .from(policyFindings)
    .where(and(eq(policyFindings.id, findingId), eq(policyFindings.orgId, orgId)))
    .limit(1);
  return f ?? null;
}

/** Asked for a decision (request_approval): new → proposed. */
export async function markProposed(orgId: string, findingId: string): Promise<void> {
  await db
    .update(policyFindings)
    .set({ status: "proposed" })
    .where(
      and(
        eq(policyFindings.id, findingId),
        eq(policyFindings.orgId, orgId),
        eq(policyFindings.status, "new"),
      ),
    );
}

/**
 * The HR head's decision. Approved: it is one of the organisation's rules from
 * now on (an earlier approved rule for the same zone and area is superseded).
 * Audited, and the judgement is captured for training (behind consent).
 */
export async function decideFindingCore(
  actor: PolicyActor,
  input: { findingId: string; decision: "approve" | "reject"; note?: string | null },
): Promise<{ status: string }> {
  await assertDecider(actor, "decide labour and hiring policy");
  const f = await findingFor(actor.orgId, input.findingId);
  if (!f) throw new Error("Finding not found.");
  if (f.status !== "new" && f.status !== "proposed")
    throw new Error(`This finding is ${f.status}, not waiting for a decision.`);
  const note = input.note?.trim() || null;
  if (input.decision === "reject" && !note) throw new Error("Say why it does not apply.");
  const status = input.decision === "approve" ? "approved" : "rejected";
  await db.transaction(async (tx) => {
    if (status === "approved")
      await tx
        .update(policyFindings)
        .set({ status: "superseded" })
        .where(
          and(
            eq(policyFindings.orgId, actor.orgId),
            eq(policyFindings.status, "approved"),
            eq(policyFindings.area, f.area),
            f.zoneId ? eq(policyFindings.zoneId, f.zoneId) : isNull(policyFindings.zoneId),
          ),
        );
    await tx
      .update(policyFindings)
      .set({ status, decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(policyFindings.id, f.id), eq(policyFindings.orgId, actor.orgId)));
  });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: `policy_finding.${status}`,
    entityType: "policy_finding",
    entityId: f.id,
    detail: { area: f.area, zoneId: f.zoneId, note },
  });
  const { captureFeedback } = await import("../server/training/capture.server");
  await captureFeedback({
    orgId: actor.orgId,
    source: "labour_policy_finding",
    label: status,
    reason: note,
    original: { quote: f.quote, summary: f.summary, rule: f.rule },
    agentRunId: f.agentRunId,
    proposedAt: f.createdAt,
    actorUserId: actor.userId,
  });
  return { status };
}

/**
 * The approved rules, as the lines every agent reads in the organisation
 * context: "• Labour rule (Italy — contracts): … (source: lavoro.gov.it, effective …)".
 */
export async function approvedRuleLines(orgId: string): Promise<string[]> {
  const rows = await db
    .select({
      area: policyFindings.area,
      rule: policyFindings.rule,
      url: policyFindings.url,
      effective: policyFindings.effectiveDate,
      zone: payZones.name,
    })
    .from(policyFindings)
    .leftJoin(payZones, eq(payZones.id, policyFindings.zoneId))
    .where(and(eq(policyFindings.orgId, orgId), eq(policyFindings.status, "approved")))
    .orderBy(policyFindings.area);
  return rows.map(
    (r) =>
      `• Labour rule (${r.zone ?? "all locations"} — ${r.area.replace(/_/g, " ")}): ${r.rule} (source: ${new URL(r.url).hostname}${r.effective ? `, effective ${r.effective}` : ""})`,
  );
}

export async function listFindings(orgId: string, limit = 50) {
  return db
    .select({
      id: policyFindings.id,
      area: policyFindings.area,
      summary: policyFindings.summary,
      rule: policyFindings.rule,
      impact: policyFindings.impact,
      quote: policyFindings.quote,
      url: policyFindings.url,
      effectiveDate: policyFindings.effectiveDate,
      status: policyFindings.status,
      decisionNote: policyFindings.decisionNote,
      createdAt: policyFindings.createdAt,
      zone: payZones.name,
    })
    .from(policyFindings)
    .leftJoin(payZones, eq(payZones.id, policyFindings.zoneId))
    .where(
      and(
        eq(policyFindings.orgId, orgId),
        or(
          inArray(policyFindings.status, ["new", "proposed", "approved"]),
          eq(policyFindings.status, "rejected"),
        ),
      ),
    )
    .orderBy(desc(policyFindings.createdAt))
    .limit(limit);
}
