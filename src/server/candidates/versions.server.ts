/**
 * CV versions, evidence claims and the consolidated profile
 * (docs/candidate-identification/track-a-design.md §2, plan row 2).
 *
 * - Every CV a person sends is a version; nothing overwrites history.
 * - Claims are extracted per version through the AI gateway (feature
 *   `cv_claims_extract`), each with an evidence strength and the passage it
 *   came from. Extraction is queued (extraction_status) and drained by
 *   `drainClaimsExtraction`, so uploads never wait on it and an archive import
 *   never fans out unbounded AI calls.
 * - The consolidated profile is computed read-side from claims of accepted
 *   versions, so it stays correct as versions and merges change.
 * - Consistency flags are display-only; nothing here changes a score or stage.
 *
 * Every query is org-scoped; callers pass the org from their auth context.
 */
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  candidateClaims,
  candidateCvVersions,
  candidateIdentitySettings,
  jobDescriptions,
  requisitions,
} from "@db/schema";
import { db } from "../db";
import { log } from "../log";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExec = typeof db | Tx;

export type VersionSource =
  | "upload"
  | "apply"
  | "inbox"
  | "board"
  | "ijp"
  | "capture"
  | "import"
  | "archive_import"
  | "manual"
  | "backfill";

export type ClaimType = "skill" | "role" | "project" | "cert" | "achievement";
export type EvidenceStrength = "demonstrated" | "listed" | "inferred";

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  demonstrated: 3,
  listed: 2,
  inferred: 1,
};

/** Claims extraction never reads more than this much of a version (design §8 Q2). */
export const CLAIMS_TEXT_CAP = 20_000;
/** Attempts before a version's extraction is marked failed. */
export const CLAIMS_MAX_ATTEMPTS = 3;
/** A running extraction is reclaimed after this long. */
const CLAIMS_LEASE_MS = 5 * 60_000;

/** Lowercase, trim, collapse whitespace, strip edge punctuation. */
export function normaliseClaimValue(v: string): string {
  return v
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:()[\]"'-]+|[\s.,;:()[\]"'-]+$/g, "")
    .trim();
}

/**
 * Record a CV version. The same file (by hash) for the same person is one
 * version: a re-upload returns the existing id and changes nothing.
 */
export async function recordCvVersion(
  input: {
    orgId: string;
    candidateId: string;
    requisitionId?: string | null;
    source: VersionSource | (string & {});
    fileHash?: string | null;
    filePath?: string | null;
    fileName?: string | null;
    parsedText: string;
    /** False for CVs from unauthenticated surfaces that matched an existing person. */
    accepted?: boolean;
    /** Queue claims extraction (default true). */
    extract?: boolean;
  },
  exec: DbExec = db,
): Promise<{ id: string; created: boolean }> {
  if (input.fileHash) {
    const [same] = await exec
      .select({ id: candidateCvVersions.id })
      .from(candidateCvVersions)
      .where(
        and(
          eq(candidateCvVersions.orgId, input.orgId),
          eq(candidateCvVersions.candidateId, input.candidateId),
          eq(candidateCvVersions.fileHash, input.fileHash),
        ),
      )
      .limit(1);
    if (same) return { id: same.id, created: false };
  }
  const text = (input.parsedText ?? "").trim();
  const [row] = await exec
    .insert(candidateCvVersions)
    .values({
      orgId: input.orgId,
      candidateId: input.candidateId,
      requisitionId: input.requisitionId ?? null,
      source: input.source,
      fileHash: input.fileHash ?? null,
      filePath: input.filePath ?? null,
      fileName: input.fileName ?? null,
      parsedText: text,
      accepted: input.accepted ?? true,
      extractionStatus:
        input.extract === false || !text || input.accepted === false ? "skipped" : "pending",
    })
    .returning({ id: candidateCvVersions.id });
  return { id: row!.id, created: true };
}

/* --------------------------------------------------------- extraction */

const loose = <T extends z.ZodTypeAny>(inner: T) => inner.nullish().catch(null);

const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        type: z.enum(["skill", "role", "project", "cert", "achievement"]),
        value: z.string().min(1).max(300),
        evidence: z.enum(["demonstrated", "listed", "inferred"]),
        passage: z.string().min(1).max(1200),
        employer: loose(z.string().max(200)),
        start: loose(z.string().max(40)),
        end: loose(z.string().max(40)),
      }),
    )
    .max(200)
    .default([]),
});
type ClaimsOut = z.infer<typeof ClaimsSchema>;

const CLAIMS_SYSTEM =
  '\nExtract every claim this CV makes about the person, as JSON {"claims": [...]}. ' +
  "Each claim: type (skill | role | project | cert | achievement), value (short normalised name, e.g. " +
  '"B2B sales", "Account Manager at Acme", "Seller onboarding programme"), evidence, passage, and for ' +
  "roles/projects the employer, start and end as written. " +
  "evidence is: demonstrated — the CV describes doing it inside a role or project with context (what, where, outcome); " +
  "listed — only named, e.g. in a skills list or summary, with no supporting detail; " +
  "inferred — not stated but strongly implied by a described role. " +
  "passage is the exact span copied from the CV that supports the claim (max ~300 characters); never paraphrase it. " +
  "Every claim must be traceable to a passage. Never invent claims, employers or dates. " +
  "One claim per distinct skill/role/project; list each role once with its dates.";

/** Extract claims for one version and store them (replacing any earlier set). */
export async function extractClaimsForVersion(
  orgId: string,
  versionId: string,
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  const [v] = await db
    .select()
    .from(candidateCvVersions)
    .where(and(eq(candidateCvVersions.id, versionId), eq(candidateCvVersions.orgId, orgId)))
    .limit(1);
  if (!v) return { ok: false, reason: "not_found" };
  if (!v.parsedText.trim()) {
    await db
      .update(candidateCvVersions)
      .set({ extractionStatus: "skipped", extractionLeaseUntil: null })
      .where(eq(candidateCvVersions.id, v.id));
    return { ok: false, reason: "empty" };
  }
  const { aiJson, INJECTION_RULES, untrusted } = await import("@/lib/ai-gateway.server");
  const { withAiSubject } = await import("../agents/context");
  const res = await withAiSubject(
    { candidateId: v.candidateId, requisitionId: v.requisitionId ?? null },
    () =>
      aiJson<ClaimsOut>({
        system: INJECTION_RULES + CLAIMS_SYSTEM,
        prompt: untrusted("cv_version", v.parsedText.slice(0, CLAIMS_TEXT_CAP)),
        orgId,
        feature: "cv_claims_extract",
        schema: ClaimsSchema,
      }),
  );
  if (!res.ok) return { ok: false, reason: "ai_failed" };

  // Keep only claims whose passage really occurs in the CV text (no invented evidence).
  const hay = v.parsedText.toLowerCase().replace(/\s+/g, " ");
  const rows = res.data.claims
    .map((c) => ({
      orgId,
      candidateId: v.candidateId,
      versionId: v.id,
      claimType: c.type,
      rawValue: c.value.trim(),
      normalisedValue: normaliseClaimValue(c.value),
      evidenceStrength: c.evidence,
      passage: c.passage.trim(),
      employer: c.employer?.trim() || null,
      startText: c.start?.trim() || null,
      endText: c.end?.trim() || null,
    }))
    .filter((c) => c.normalisedValue && passageOccurs(hay, c.passage));

  await db.transaction(async (tx) => {
    await tx
      .delete(candidateClaims)
      .where(and(eq(candidateClaims.versionId, v.id), eq(candidateClaims.orgId, orgId)));
    if (rows.length) await tx.insert(candidateClaims).values(rows);
    await tx
      .update(candidateCvVersions)
      .set({ extractionStatus: "done", extractionLeaseUntil: null })
      .where(eq(candidateCvVersions.id, v.id));
  });
  return { ok: true, count: rows.length };
}

/** True when the passage (whitespace-insensitive, case-insensitive) is in the CV. */
export function passageOccurs(normalisedHay: string, passage: string): boolean {
  const needle = passage.toLowerCase().replace(/\s+/g, " ").trim();
  if (needle.length < 3) return false;
  if (normalisedHay.includes(needle)) return true;
  // Tolerate a trimmed ellipsis or one changed edge word: the middle 60% must occur.
  const cut = Math.floor(needle.length * 0.2);
  const middle = needle.slice(cut, needle.length - cut);
  return middle.length >= 12 && normalisedHay.includes(middle);
}

/**
 * Drain queued extractions: reclaim expired leases, claim a batch with
 * SKIP LOCKED, process with bounded concurrency. An org at its AI spend cap is
 * deferred without burning attempts.
 */
export async function drainClaimsExtraction(
  opts: { limit?: number; concurrency?: number; orgId?: string } = {},
): Promise<{ claimed: number; done: number; failed: number; deferred: number }> {
  const limit = opts.limit ?? 20;
  const now = new Date();
  await db
    .update(candidateCvVersions)
    .set({ extractionStatus: "pending", extractionLeaseUntil: null })
    .where(
      and(
        eq(candidateCvVersions.extractionStatus, "running"),
        lt(candidateCvVersions.extractionLeaseUntil, now),
      ),
    );
  const orgFilter = opts.orgId ? sql`and org_id = ${opts.orgId}` : sql``;
  const claimed = (await db.execute(sql`
    update candidate_cv_versions set extraction_status = 'running',
      extraction_lease_until = ${new Date(Date.now() + CLAIMS_LEASE_MS).toISOString()}::timestamptz,
      extraction_attempts = extraction_attempts + 1
    where id in (
      select id from candidate_cv_versions
      where extraction_status = 'pending' ${orgFilter}
      order by created_at
      limit ${limit}
      for update skip locked
    )
    returning id, org_id, extraction_attempts
  `)) as unknown as { rows?: Row[] } | Row[];
  type Row = { id: string; org_id: string; extraction_attempts: number };
  const items: Row[] = Array.isArray(claimed) ? claimed : (claimed.rows ?? []);
  const counts = { claimed: items.length, done: 0, failed: 0, deferred: 0 };
  if (!items.length) return counts;

  const { spendCapRefusal } = await import("../ai-spend-cap");
  const capped = new Map<string, boolean>();
  for (const org of new Set(items.map((i) => i.org_id)))
    capped.set(org, Boolean(await spendCapRefusal(org)));

  const queue = [...items];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      if (capped.get(it.org_id)) {
        await db
          .update(candidateCvVersions)
          .set({
            extractionStatus: "pending",
            extractionLeaseUntil: null,
            extractionAttempts: sql`greatest(${candidateCvVersions.extractionAttempts} - 1, 0)`,
          })
          .where(eq(candidateCvVersions.id, it.id));
        counts.deferred++;
        continue;
      }
      try {
        const r = await extractClaimsForVersion(it.org_id, it.id);
        if (r.ok || r.reason === "empty") counts.done++;
        else throw new Error(r.reason);
      } catch (e) {
        const final = it.extraction_attempts >= CLAIMS_MAX_ATTEMPTS;
        await db
          .update(candidateCvVersions)
          .set({ extractionStatus: final ? "failed" : "pending", extractionLeaseUntil: null })
          .where(eq(candidateCvVersions.id, it.id));
        if (final) counts.failed++;
        log.warn("claims.extract_failed", {
          org_id: it.org_id,
          version_id: it.id,
          final,
          error: e as Error,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  if (counts.done) {
    const { queueMatchesForOrgs } = await import("./profile-match.server");
    await queueMatchesForOrgs([...new Set(items.map((i) => i.org_id))]).catch((e: unknown) =>
      log.warn("claims.queue_matches_failed", { error: e as Error }),
    );
  }
  return counts;
}

/** Re-queue extraction for a candidate's versions (e.g. backfilled or failed ones). */
export async function requeueClaimsExtraction(
  orgId: string,
  candidateIds: string[],
): Promise<number> {
  if (!candidateIds.length) return 0;
  const rows = await db
    .update(candidateCvVersions)
    .set({ extractionStatus: "pending", extractionAttempts: 0, extractionLeaseUntil: null })
    .where(
      and(
        eq(candidateCvVersions.orgId, orgId),
        inArray(candidateCvVersions.candidateId, candidateIds),
        inArray(candidateCvVersions.extractionStatus, ["skipped", "failed"]),
        sql`${candidateCvVersions.parsedText} <> ''`,
      ),
    )
    .returning({ id: candidateCvVersions.id });
  return rows.length;
}

/* ------------------------------------------------- consolidated profile */

export type ProfileClaim = {
  type: ClaimType;
  value: string;
  strength: EvidenceStrength;
  versionIds: string[];
  firstSeenAt: string;
  passage: string;
  passageVersionId: string;
  claimId: string;
  employer: string | null;
  start: string | null;
  end: string | null;
  /** Listed-only, in one version, and that version was sent for the role being viewed. */
  singleSource: boolean;
};

export type ProfileFlag =
  | { kind: "date_conflict"; employer: string; detail: string[] }
  | { kind: "title_conflict"; employer: string; detail: string[] }
  | { kind: "employer_overlap"; detail: string[] }
  | { kind: "single_source"; values: string[] }
  | { kind: "jd_mirroring"; versionId: string; overlap: number };

export type ProfileVersion = {
  id: string;
  source: string;
  fileName: string | null;
  requisitionId: string | null;
  submittedAt: string;
  accepted: boolean;
  extractionStatus: string;
  claimCount: number;
};

export type ConsolidatedProfile = {
  versions: ProfileVersion[];
  claims: ProfileClaim[];
  flags: ProfileFlag[];
};

export type FlagConfig = {
  dateConflict?: boolean;
  titleConflict?: boolean;
  employerOverlap?: boolean;
  singleSource?: boolean;
  jdMirroring?: boolean;
  jdMirroringThreshold?: number;
};

const DEFAULT_MIRROR_THRESHOLD = 0.2;

/**
 * The person as all their accepted CVs describe them. `requisitionId` (the role
 * being viewed) enables the single-source and JD-mirroring flags.
 */
export async function getConsolidatedProfile(
  orgId: string,
  candidateId: string,
  opts: { requisitionId?: string | null } = {},
): Promise<ConsolidatedProfile> {
  const versions = await db
    .select({
      id: candidateCvVersions.id,
      source: candidateCvVersions.source,
      fileName: candidateCvVersions.fileName,
      requisitionId: candidateCvVersions.requisitionId,
      submittedAt: candidateCvVersions.submittedAt,
      accepted: candidateCvVersions.accepted,
      extractionStatus: candidateCvVersions.extractionStatus,
      parsedText: candidateCvVersions.parsedText,
    })
    .from(candidateCvVersions)
    .where(
      and(eq(candidateCvVersions.orgId, orgId), eq(candidateCvVersions.candidateId, candidateId)),
    )
    .orderBy(desc(candidateCvVersions.submittedAt));
  const acceptedIds = versions.filter((v) => v.accepted).map((v) => v.id);
  const claimRows = acceptedIds.length
    ? await db
        .select()
        .from(candidateClaims)
        .where(
          and(eq(candidateClaims.orgId, orgId), inArray(candidateClaims.versionId, acceptedIds)),
        )
        .orderBy(asc(candidateClaims.createdAt))
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const countByVersion = new Map<string, number>();
  for (const c of claimRows)
    countByVersion.set(c.versionId, (countByVersion.get(c.versionId) ?? 0) + 1);

  const cfg = await flagConfigOf(orgId);
  const claims = consolidateClaims(
    claimRows.map((c) => ({
      id: c.id,
      versionId: c.versionId,
      type: c.claimType,
      value: c.rawValue,
      key: c.normalisedValue,
      strength: c.evidenceStrength,
      passage: c.passage,
      employer: c.employer,
      start: c.startText,
      end: c.endText,
      submittedAt: versionById.get(c.versionId)?.submittedAt ?? new Date(0),
      versionRequisitionId: versionById.get(c.versionId)?.requisitionId ?? null,
    })),
    opts.requisitionId ?? null,
  );

  const flags: ProfileFlag[] = [];
  // Conflicts live between versions, so they are read from the raw role claims —
  // consolidation would fold two versions of one role into a single entry.
  const roleFlags = timelineFlags(
    claimRows
      .filter((c) => c.claimType === "role")
      .map((c) => ({
        type: "role" as const,
        value: c.rawValue,
        employer: c.employer,
        start: c.startText,
        end: c.endText,
        versionIds: [c.versionId],
      })),
  );
  for (const f of roleFlags) {
    if (f.kind === "date_conflict" && cfg.dateConflict === false) continue;
    if (f.kind === "title_conflict" && cfg.titleConflict === false) continue;
    if (f.kind === "employer_overlap" && cfg.employerOverlap === false) continue;
    flags.push(f);
  }
  const single = claims.filter((c) => c.singleSource).map((c) => c.value);
  if (single.length && cfg.singleSource !== false)
    flags.push({ kind: "single_source", values: single });

  if (opts.requisitionId && cfg.jdMirroring !== false) {
    const jdText = await jdTextOf(orgId, opts.requisitionId);
    const threshold = cfg.jdMirroringThreshold ?? DEFAULT_MIRROR_THRESHOLD;
    if (jdText)
      for (const v of versions.filter((x) => x.requisitionId === opts.requisitionId)) {
        const overlap = shingleContainment(v.parsedText, jdText);
        if (overlap >= threshold)
          flags.push({ kind: "jd_mirroring", versionId: v.id, overlap: round2(overlap) });
      }
  }

  return {
    versions: versions.map((v) => ({
      id: v.id,
      source: v.source,
      fileName: v.fileName,
      requisitionId: v.requisitionId,
      submittedAt: v.submittedAt.toISOString(),
      accepted: v.accepted,
      extractionStatus: v.extractionStatus,
      claimCount: countByVersion.get(v.id) ?? 0,
    })),
    claims,
    flags,
  };
}

type RawClaim = {
  id: string;
  versionId: string;
  type: ClaimType;
  value: string;
  key: string;
  strength: EvidenceStrength;
  passage: string;
  employer: string | null;
  start: string | null;
  end: string | null;
  submittedAt: Date;
  versionRequisitionId: string | null;
};

/**
 * Group claims across versions by (type, normalised value). Strength is the max
 * across versions; the passage comes from the strongest version (longest
 * passage on ties, so the fullest project description wins).
 */
export function consolidateClaims(
  raw: RawClaim[],
  viewingRequisitionId: string | null,
): ProfileClaim[] {
  const groups = new Map<string, RawClaim[]>();
  for (const c of raw) {
    const k = `${c.type}|${c.type === "role" ? `${c.key}|${normaliseClaimValue(c.employer ?? "")}` : c.key}`;
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const out: ProfileClaim[] = [];
  for (const g of groups.values()) {
    const best = [...g].sort(
      (a, b) =>
        STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] ||
        b.passage.length - a.passage.length,
    )[0]!;
    const versionIds = [...new Set(g.map((c) => c.versionId))];
    const first = g.reduce((m, c) => (c.submittedAt < m ? c.submittedAt : m), g[0]!.submittedAt);
    const strength = best.strength;
    out.push({
      type: best.type,
      value: best.value,
      strength,
      versionIds,
      firstSeenAt: first.toISOString(),
      passage: best.passage,
      passageVersionId: best.versionId,
      claimId: best.id,
      employer: best.employer,
      start: best.start,
      end: best.end,
      singleSource:
        strength === "listed" &&
        versionIds.length === 1 &&
        viewingRequisitionId !== null &&
        g[0]!.versionRequisitionId === viewingRequisitionId,
    });
  }
  return out.sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] ||
      a.value.localeCompare(b.value),
  );
}

/** Role-claim conflicts across versions: same employer with different dates or titles, overlapping employers. */
export function timelineFlags(
  roles: Pick<ProfileClaim, "value" | "employer" | "start" | "end" | "versionIds" | "type">[],
): ProfileFlag[] {
  const flags: ProfileFlag[] = [];
  const byEmployer = new Map<string, typeof roles>();
  for (const r of roles) {
    const e = normaliseClaimValue(r.employer ?? "");
    if (!e) continue;
    const g = byEmployer.get(e);
    if (g) g.push(r);
    else byEmployer.set(e, [r]);
  }
  for (const [employer, g] of byEmployer) {
    const dates = new Set(g.map((r) => `${yearOf(r.start) ?? "?"}–${yearOf(r.end) ?? "?"}`));
    const titles = new Set(g.map((r) => normaliseClaimValue(r.value.replace(/\s+at\s+.*$/i, ""))));
    // Same employer, one title, different dates: a date conflict between versions.
    if (titles.size === 1 && dates.size > 1)
      flags.push({ kind: "date_conflict", employer, detail: [...dates] });
    // Same employer and same period, different titles.
    const byPeriod = new Map<string, Set<string>>();
    for (const r of g) {
      const p = `${yearOf(r.start) ?? "?"}–${yearOf(r.end) ?? "?"}`;
      const t = normaliseClaimValue(r.value.replace(/\s+at\s+.*$/i, ""));
      const s = byPeriod.get(p) ?? new Set<string>();
      s.add(t);
      byPeriod.set(p, s);
    }
    for (const [p, ts] of byPeriod)
      if (ts.size > 1) flags.push({ kind: "title_conflict", employer, detail: [p, ...ts] });
  }
  // Full-time overlap between different employers (both with full year ranges, > 1 year overlap).
  const spans = [...byEmployer].flatMap(([employer, g]) =>
    g
      .map((r) => ({ employer, s: yearOf(r.start), e: yearOf(r.end) ?? currentYearIf(r.end) }))
      .filter((x): x is { employer: string; s: number; e: number } => x.s !== null && x.e !== null),
  );
  const seen = new Set<string>();
  for (let i = 0; i < spans.length; i++)
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (a.employer === b.employer) continue;
      const overlap = Math.min(a.e, b.e) - Math.max(a.s, b.s);
      const key = [a.employer, b.employer].sort().join("|");
      if (overlap > 1 && !seen.has(key)) {
        seen.add(key);
        flags.push({
          kind: "employer_overlap",
          detail: [`${a.employer} ${a.s}–${a.e}`, `${b.employer} ${b.s}–${b.e}`],
        });
      }
    }
  return flags;
}

function yearOf(s: string | null | undefined): number | null {
  const m = (s ?? "").match(/\b(19[5-9]\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

function currentYearIf(s: string | null | undefined): number | null {
  return /present|current|now|today|date/i.test(s ?? "") ? new Date().getFullYear() : null;
}

/**
 * Share of the CV's 5-word shingles that also occur in the JD. A tailored CV
 * that copies the JD's sentences scores high; normal skill overlap does not
 * (single words and short phrases never form a 5-word shingle).
 */
export function shingleContainment(cvText: string, jdText: string, n = 5): number {
  const shingles = (t: string) => {
    const w = t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
    const s = new Set<string>();
    for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(" "));
    return s;
  };
  const cv = shingles(cvText);
  if (!cv.size) return 0;
  const jd = shingles(jdText);
  let hit = 0;
  for (const s of cv) if (jd.has(s)) hit++;
  return hit / cv.size;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

async function jdTextOf(orgId: string, requisitionId: string): Promise<string | null> {
  const [jd] = await db
    .select({ fullText: jobDescriptions.fullText })
    .from(jobDescriptions)
    .innerJoin(requisitions, eq(requisitions.id, jobDescriptions.requisitionId))
    .where(
      and(
        eq(jobDescriptions.requisitionId, requisitionId),
        eq(requisitions.orgId, orgId),
        or(eq(jobDescriptions.orgId, orgId), sql`${jobDescriptions.orgId} is null`),
      ),
    )
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  return jd?.fullText ?? null;
}

async function flagConfigOf(orgId: string): Promise<FlagConfig> {
  const [row] = await db
    .select({ flagConfig: candidateIdentitySettings.flagConfig })
    .from(candidateIdentitySettings)
    .where(eq(candidateIdentitySettings.orgId, orgId))
    .limit(1);
  return ((row?.flagConfig ?? {}) as FlagConfig) || {};
}

/** Accept a pending (public-surface) version into the profile and queue its claims. */
export async function acceptCvVersion(orgId: string, versionId: string): Promise<boolean> {
  const rows = await db
    .update(candidateCvVersions)
    .set({
      accepted: true,
      extractionStatus: sql`case when ${candidateCvVersions.parsedText} = '' then 'skipped' when ${candidateCvVersions.extractionStatus} = 'done' then 'done' else 'pending' end`,
    })
    .where(
      and(
        eq(candidateCvVersions.id, versionId),
        eq(candidateCvVersions.orgId, orgId),
        eq(candidateCvVersions.accepted, false),
      ),
    )
    .returning({ id: candidateCvVersions.id });
  return rows.length > 0;
}
