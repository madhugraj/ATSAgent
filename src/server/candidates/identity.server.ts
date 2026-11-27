/**
 * Candidate identity resolution (plan row 1) — the write-side core.
 *
 * Design: docs/candidate-identification/track-a-design.md §1. Rules in short:
 *  - strong keys (email / full-E.164 phone / linkedin / github / file hash)
 *    merge automatically when the tenant has autoMergeStrongKeys on;
 *  - shared contact details (shared_* keys) and fuzzy evidence never merge
 *    automatically — the caller enqueues a candidate_merge_suggestions row and
 *    a person decides;
 *  - merges are reversible: the absorbed row becomes a tombstone
 *    (candidates.mergedIntoId) and candidate_merges.undo_snapshot holds the
 *    full pre-merge state of everything the merge touched;
 *  - undo is refused when a re-pointed child changed after the merge;
 *  - every query carries the caller's org_id — identity never crosses tenants.
 */
import { and, desc, eq, getTableName, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "../db";
import { writeAudit } from "../audit";
import {
  applications,
  candidateAssessments,
  candidateIdentityKeys,
  candidateIdentitySettings,
  candidateMergeSuggestions,
  candidateMerges,
  candidateNotes,
  candidateOwnershipEvents,
  candidateReferrals,
  candidateVerifications,
  candidates,
  captureEvents,
  inboxMessages,
  skillEvidence,
  socialProfiles,
  trainingFeedback,
} from "@db/schema";
import {
  fuzzyIdentityScore,
  isPlaceholderEmail,
  normEmail,
  normPhone,
  normProfileUrl,
  nameTokens,
  tokenJaccard,
  type TimelineEntry,
} from "../../lib/candidates/identity-normalise";

type CandRow = typeof candidates.$inferSelect;
type KeyRow = typeof candidateIdentityKeys.$inferSelect;
export type NewKey = { keyType: KeyRow["keyType"]; keyValue: string };
/** The transaction handle db.transaction hands its callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type IdentitySettings = typeof candidateIdentitySettings.$inferSelect;

const DEFAULT_SETTINGS: Omit<IdentitySettings, "orgId" | "updatedAt" | "updatedBy"> = {
  autoMergeStrongKeys: true,
  fuzzyHighThreshold: "0.85",
  fuzzyLowThreshold: "0.60",
  defaultPhoneRegion: null,
  flagConfig: {},
};

export const getIdentitySettings = async (orgId: string): Promise<IdentitySettings> => {
  const [row] = await db
    .select()
    .from(candidateIdentitySettings)
    .where(eq(candidateIdentitySettings.orgId, orgId))
    .limit(1);
  if (row) return row;
  return { orgId, ...DEFAULT_SETTINGS, updatedAt: new Date(), updatedBy: null };
};

/* ------------------------------------------------------------------ keys */

export type IdentityKeyInput = {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  fileHash?: string | null;
  externalProvider?: string | null;
  externalId?: string | null;
};

/** The auto-merge key types backed by the partial unique index. */
const STRONG_TYPES: KeyRow["keyType"][] = ["email", "phone", "linkedin", "github", "file_hash"];

/**
 * Normalised identity keys for one person. Placeholder addresses key under
 * `placeholder` (they match each other by equality exactly as today's lookup
 * does, never a real address); a phone that only parses to last-10-digits
 * keys under `shared_phone` — a collision there may be two people sharing a
 * number, so it reviews instead of merging (design §1.2).
 */
export function computeIdentityKeys(
  input: IdentityKeyInput,
  defaultRegion?: string | null,
): NewKey[] {
  const keys: NewKey[] = [];
  const rawEmail = (input.email ?? "").trim();
  const email = normEmail(rawEmail);
  if (email) keys.push({ keyType: "email", keyValue: email });
  else if (rawEmail && isPlaceholderEmail(rawEmail))
    keys.push({ keyType: "placeholder", keyValue: rawEmail.toLowerCase() });
  const phone = normPhone(input.phone, defaultRegion);
  if (phone.strong) keys.push({ keyType: "phone", keyValue: phone.strong });
  else if (phone.weak) keys.push({ keyType: "shared_phone", keyValue: phone.weak });
  const linkedin = normProfileUrl(input.linkedinUrl);
  if (linkedin) keys.push({ keyType: "linkedin", keyValue: linkedin });
  const github = normProfileUrl(input.githubUrl);
  if (github) keys.push({ keyType: "github", keyValue: github });
  if (input.fileHash) keys.push({ keyType: "file_hash", keyValue: input.fileHash });
  if (input.externalProvider && input.externalId)
    keys.push({
      keyType: "external",
      keyValue: `${input.externalProvider}:${input.externalId}`,
    });
  return keys;
}

const SHARED_TYPE_NAMES = [
  "shared_email",
  "shared_phone",
  "shared_linkedin",
  "shared_github",
] as const;

const sharedTypeOf = (t: KeyRow["keyType"]): KeyRow["keyType"] | null =>
  t === "email"
    ? "shared_email"
    : t === "phone"
      ? "shared_phone"
      : t === "linkedin"
        ? "shared_linkedin"
        : t === "github"
          ? "shared_github"
          : null;

/* --------------------------------------------------------------- resolve */

export type ResolveIdentityInput = IdentityKeyInput & {
  orgId: string;
  location?: string | null;
  education?: string | null;
  employmentHistory?: TimelineEntry[];
};

export type ResolveIdentityOutcome =
  | { outcome: "merged"; candidateId: string; matchedKey: NewKey }
  /** Same file bytes and agreeing name: attach as a version (A2), not a new person. */
  | { outcome: "attach"; candidateId: string }
  | {
      outcome: "review";
      matchedCandidateId: string;
      score: number;
      reasons: { signal: string; detail: string }[];
    }
  | { outcome: "new" };

/**
 * Resolve a newcomer against one organisation's pool. Called from every
 * org-scoped intake path (A1b wires the callers). On `review` the caller
 * creates the newcomer row and then calls [[enqueueMergeSuggestion]] — the
 * suggestion needs both ids, so it is deliberately two-phase. Key collisions
 * read through the partial unique index; fuzzy pairs come from a name-token
 * block and are scored with timeline/education evidence. Nothing fuzzy merges
 * here, ever.
 */
export async function resolveIdentity(
  input: ResolveIdentityInput,
): Promise<ResolveIdentityOutcome> {
  const settings = await getIdentitySettings(input.orgId);
  const keys = computeIdentityKeys(input, settings.defaultPhoneRegion);
  const name = input.fullName ?? "";

  // Probe each computed key AND its shared_* counterpart: a contact detail
  // decided keep-separate before carries a shared_* key on the newcomer, and
  // that demotion must be visible to the lookup (M0 finding 1).
  const lookupTuples: { keyType: KeyRow["keyType"]; keyValue: string }[] = [...keys];
  for (const k of keys) {
    const shared = sharedTypeOf(k.keyType);
    if (shared) lookupTuples.push({ keyType: shared, keyValue: k.keyValue });
  }

  // 1. Block: which existing candidates hold any of these keys?
  const hits = lookupTuples.length
    ? await db
        .select({ key: candidateIdentityKeys })
        .from(candidateIdentityKeys)
        .innerJoin(candidates, eq(candidates.id, candidateIdentityKeys.candidateId))
        .where(
          and(
            eq(candidateIdentityKeys.orgId, input.orgId),
            isNull(candidates.mergedIntoId),
            or(
              ...lookupTuples.map((k) =>
                and(
                  eq(candidateIdentityKeys.keyType, k.keyType),
                  eq(candidateIdentityKeys.keyValue, k.keyValue),
                ),
              ),
            ),
          ),
        )
    : [];

  const byCandidate = new Map<string, KeyRow[]>();
  for (const h of hits) {
    const list = byCandidate.get(h.key.candidateId) ?? [];
    list.push(h.key);
    byCandidate.set(h.key.candidateId, list);
  }

  // 2. File hash first (design §1.3 rule 1): bytes say nothing about the person.
  const fileHit = [...byCandidate.entries()].find(([, ks]) =>
    ks.some((k) => k.keyType === "file_hash"),
  );
  if (fileHit) {
    const [existing] = await db
      .select({ fullName: candidates.fullName })
      .from(candidates)
      .where(and(eq(candidates.id, fileHit[0]), eq(candidates.orgId, input.orgId)))
      .limit(1);
    const sameName = tokenJaccard(nameTokens(name), nameTokens(existing?.fullName ?? "")) >= 0.5;
    if (sameName) return { outcome: "attach", candidateId: fileHit[0] };
    return {
      outcome: "review",
      matchedCandidateId: fileHit[0],
      score: 0,
      reasons: [{ signal: "file_hash", detail: "identical file bytes, different name" }],
    };
  }

  // 3. A shared contact detail — review, never auto-merge (M0 finding 1).
  // A shared_* key exists exactly when this contact detail was decided
  // keep-separate before, or is only weakly parsed (last-10-digits phone) —
  // either way the detail must not auto-merge anyone again, including the
  // original strong-key owner.
  const sharedHit = [...byCandidate.entries()].find(([, ks]) =>
    ks.some((k) => (SHARED_TYPE_NAMES as readonly string[]).includes(k.keyType)),
  );
  if (sharedHit) {
    const shared = sharedHit[1].find((k) =>
      (SHARED_TYPE_NAMES as readonly string[]).includes(k.keyType),
    )!;
    return {
      outcome: "review",
      matchedCandidateId: sharedHit[0],
      score: 1,
      reasons: [{ signal: `shared_key:${shared.keyType}`, detail: shared.keyValue }],
    };
  }

  // 4. Strong keys (and placeholder equality, today's email-less dedupe).
  const isStrong = (k: KeyRow) =>
    (STRONG_TYPES as string[]).includes(k.keyType) || k.keyType === "placeholder";
  const strongHit = [...byCandidate.entries()].find(([, ks]) => ks.some(isStrong));
  if (strongHit) {
    const strong = strongHit[1].find(isStrong)!;
    if (settings.autoMergeStrongKeys)
      return {
        outcome: "merged",
        candidateId: strongHit[0],
        matchedKey: { keyType: strong.keyType, keyValue: strong.keyValue },
      };
    return {
      outcome: "review",
      matchedCandidateId: strongHit[0],
      score: 1,
      reasons: [{ signal: `strong_key:${strong.keyType}`, detail: strong.keyValue }],
    };
  }

  // 5. No key overlap: fuzzy career-history evidence decides.
  return findFuzzyMatches(input, settings);
}

const NAME_BLOCK_LIMIT = 200;

/**
 * Coarse block by name token, then score. With no key overlap there is no
 * bucket, so a token-ILIKE block keeps the scan bounded; the fuzzy score —
 * never the block itself — decides the outcome.
 */
async function findFuzzyMatches(
  input: ResolveIdentityInput,
  settings: IdentitySettings,
): Promise<ResolveIdentityOutcome> {
  const tokens = nameTokens(input.fullName);
  if (tokens.length === 0) return { outcome: "new" };
  const block = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.orgId, input.orgId),
        isNull(candidates.mergedIntoId),
        or(...tokens.map((t) => sql`${candidates.fullName} ilike ${"%" + t + "%"}`)),
      ),
    )
    .limit(NAME_BLOCK_LIMIT);
  if (block.length === 0) return { outcome: "new" };

  const low = Number(settings.fuzzyLowThreshold);
  let best: { row: CandRow; reasons: { signal: string; detail: string }[]; score: number } | null =
    null;
  for (const row of block) {
    const { score, signals } = fuzzyIdentityScore({
      fullNameA: input.fullName,
      fullNameB: row.fullName,
      timelineA: input.employmentHistory ?? [],
      timelineB: (row.employmentHistory as TimelineEntry[] | null) ?? [],
      educationA: input.education ?? null,
      educationB: row.education ?? null,
      locationA: input.location ?? null,
      locationB: row.location ?? null,
    });
    if (!best || score > best.score) best = { row, reasons: signals, score };
  }
  if (!best || best.score < low) return { outcome: "new" };
  return {
    outcome: "review",
    matchedCandidateId: best.row.id,
    score: best.score,
    reasons: best.reasons,
  };
}

/**
 * Record a pending pair for the merge review queue. candidateA is the
 * existing (matched) record, candidateB the newcomer. No-ops when an
 * unresolved suggestion for the same pair already exists.
 */
export async function enqueueMergeSuggestion(input: {
  orgId: string;
  existingId: string;
  newcomerId: string;
  score: number;
  reasons: { signal: string; detail: string }[];
}): Promise<{ id: string } | null> {
  if (input.existingId === input.newcomerId) return null;
  const [pending] = await db
    .select({ id: candidateMergeSuggestions.id })
    .from(candidateMergeSuggestions)
    .where(
      and(
        eq(candidateMergeSuggestions.orgId, input.orgId),
        eq(candidateMergeSuggestions.status, "pending"),
        or(
          and(
            eq(candidateMergeSuggestions.candidateAId, input.existingId),
            eq(candidateMergeSuggestions.candidateBId, input.newcomerId),
          ),
          and(
            eq(candidateMergeSuggestions.candidateAId, input.newcomerId),
            eq(candidateMergeSuggestions.candidateBId, input.existingId),
          ),
        ),
      ),
    )
    .orderBy(desc(candidateMergeSuggestions.createdAt))
    .limit(1);
  if (pending) return null;
  const [row] = await db
    .insert(candidateMergeSuggestions)
    .values({
      orgId: input.orgId,
      candidateAId: input.existingId,
      candidateBId: input.newcomerId,
      score: input.score.toFixed(3),
      reasons: input.reasons,
    })
    .returning({ id: candidateMergeSuggestions.id });
  return row ?? null;
}

/* ----------------------------------------------------------------- merge */

export type MergeActor = { userId?: string | null; email?: string | null; system?: string | null };

/** Deterministic JSON: sorted keys, dates as ISO — jsonb loses key order. */
function canonJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort())
        out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Fingerprint of a child row, for the undo-refusal rule (M0 finding 4).
 *  Excludes candidateId — the merge rewrites it by design; the refusal rule
 *  targets real post-merge activity (stage moves, edits, notes). */
function fingerprintOf(table: string, row: Record<string, unknown>): string {
  if (table === "applications")
    return canonJson({
      stage: row["stage"],
      lastActivityAt: row["lastActivityAt"],
      stageNote: row["stageNote"],
      stageReason: row["stageReason"],
    });
  const { candidateId: _ignored, ...rest } = row;
  return canonJson(rest);
}

export type MergeUndoSnapshot = {
  absorbed: CandRow;
  /** Full pre-merge rows of children the merge re-pointed to the survivor. */
  repointed: { table: string; row: Record<string, unknown> }[];
  /** Full rows of children the merge deleted outright (same-requisition duplicates). */
  deleted: { table: "applications"; row: Record<string, unknown> }[];
  /** Key rows that moved from the absorbed candidate to the survivor. */
  keys: { keyType: KeyRow["keyType"]; keyValue: string }[];
};

/**
 * Per-table operations for the candidate-child tables that follow a merge.
 * Typed per table because drizzle's update set-shape is table-specific; the
 * snapshot/undo logic stays generic over the descriptor.
 */
function childDescriptors(tx: Tx, orgId: string) {
  const tables = [
    socialProfiles,
    candidateVerifications,
    candidateAssessments,
    candidateNotes,
    candidateReferrals,
    candidateOwnershipEvents,
    skillEvidence,
    trainingFeedback,
    inboxMessages,
    captureEvents,
  ] as const;
  return tables.map((t) => ({
    name: getTableName(t),
    rows: async (candidateId: string) =>
      (
        await tx
          .select()
          .from(t)
          .where(and(eq(t.candidateId, candidateId), eq(t.orgId, orgId)))
      ).map((r) => r as unknown as Record<string, unknown>),
    get: async (id: string) => {
      const [row] = await tx.select().from(t).where(eq(t.id, id)).limit(1);
      return (row ?? undefined) as unknown as Record<string, unknown> | undefined;
    },
    repoint: async (id: string, to: string) => {
      await tx
        .update(t)
        .set({ candidateId: to } as never)
        .where(eq(t.id, id));
    },
  }));
}

const isBlank = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "number" && v === 0);

/** Fill-blanks field merge — the single server-side source (design §1.1). */
export function mergeCandidateFields(
  survivor: CandRow,
  absorbed: CandRow,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const skills = new Set((survivor.skills ?? []).map((s) => s.trim()).filter(Boolean));
  const resume = survivor.resumeText ?? "";
  for (const [key, value] of Object.entries(absorbed)) {
    if (
      ["id", "createdAt", "orgId", "skills", "resumeText", "mergedIntoId", "fileHash"].includes(key)
    )
      continue;
    const current = (survivor as unknown as Record<string, unknown>)[key];
    if (isBlank(current) && !isBlank(value)) patch[key] = value;
  }
  for (const s of absorbed.skills ?? []) if (s.trim()) skills.add(s.trim());
  if (skills.size !== (survivor.skills ?? []).length) patch["skills"] = [...skills];
  if ((absorbed.resumeText ?? "").length > resume.length) patch["resumeText"] = absorbed.resumeText;
  return patch;
}

export type MergeResult = {
  mergeId: string;
  survivorId: string;
  mergedId: string;
  movedChildren: number;
  deletedChildren: number;
};

/**
 * Merge one absorbed candidate into a survivor, reversibly. Tombstone over
 * delete; everything the merge touches lands in undo_snapshot in the same
 * transaction. `suggestionId`, when given, is decided as `merged`.
 */
export async function mergeCandidatesCore(opts: {
  orgId: string;
  survivorId: string;
  mergedId: string;
  actor: MergeActor;
  suggestionId?: string | null;
  decisionNote?: string | null;
}): Promise<MergeResult> {
  const { orgId, actor } = opts;
  if (opts.survivorId === opts.mergedId) throw new Error("A candidate cannot merge into itself.");

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(candidates)
      .where(
        and(inArray(candidates.id, [opts.survivorId, opts.mergedId]), eq(candidates.orgId, orgId)),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const survivor = byId.get(opts.survivorId);
    const absorbed = byId.get(opts.mergedId);
    if (!survivor || !absorbed) throw new Error("Both candidates must exist in your organisation.");
    if (survivor.mergedIntoId) throw new Error("The survivor has already been merged elsewhere.");
    if (absorbed.mergedIntoId) throw new Error("That candidate has already been merged.");

    const patch = mergeCandidateFields(survivor, absorbed);
    if (Object.keys(patch).length > 0)
      await tx.update(candidates).set(patch).where(eq(candidates.id, survivor.id));

    const snapshot: MergeUndoSnapshot = { absorbed, repointed: [], deleted: [], keys: [] };

    // Applications: re-point, deleting true same-requisition duplicates
    // (applications_requisition_candidate_key forces it — they are snapshotted
    // so undo re-inserts them with their original ids and dates, M0 Q4).
    const dupeApps = await tx
      .select()
      .from(applications)
      .where(and(eq(applications.candidateId, absorbed.id), eq(applications.orgId, orgId)));
    const survivorApps = await tx
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(and(eq(applications.candidateId, survivor.id), eq(applications.orgId, orgId)));
    const taken = new Set(survivorApps.map((a) => a.requisitionId));
    let movedChildren = 0;
    let deletedChildren = 0;
    for (const a of dupeApps) {
      if (taken.has(a.requisitionId)) {
        snapshot.deleted.push({
          table: "applications",
          row: a as unknown as Record<string, unknown>,
        });
        await tx.delete(applications).where(eq(applications.id, a.id));
        deletedChildren++;
        continue;
      }
      snapshot.repointed.push({
        table: getTableName(applications),
        row: a as unknown as Record<string, unknown>,
      });
      await tx
        .update(applications)
        .set({ candidateId: survivor.id })
        .where(eq(applications.id, a.id));
      movedChildren++;
    }

    // Direct children: snapshot then re-point.
    for (const d of childDescriptors(tx, orgId)) {
      for (const row of await d.rows(absorbed.id)) {
        snapshot.repointed.push({ table: d.name, row });
        await d.repoint(row["id"] as string, survivor.id);
        movedChildren++;
      }
    }

    // Identity keys follow the survivor; a key the survivor already holds is
    // dropped (same value, same org — one row is the guarantee).
    const keyRows = await tx
      .select()
      .from(candidateIdentityKeys)
      .where(
        and(
          eq(candidateIdentityKeys.orgId, orgId),
          eq(candidateIdentityKeys.candidateId, absorbed.id),
        ),
      );
    const survivorKeys = await tx
      .select()
      .from(candidateIdentityKeys)
      .where(
        and(
          eq(candidateIdentityKeys.orgId, orgId),
          eq(candidateIdentityKeys.candidateId, survivor.id),
        ),
      );
    const held = new Set(survivorKeys.map((k) => `${k.keyType}|${k.keyValue}`));
    for (const k of keyRows) {
      snapshot.keys.push({ keyType: k.keyType, keyValue: k.keyValue });
      if (held.has(`${k.keyType}|${k.keyValue}`))
        await tx.delete(candidateIdentityKeys).where(eq(candidateIdentityKeys.id, k.id));
      else
        await tx
          .update(candidateIdentityKeys)
          .set({ candidateId: survivor.id })
          .where(eq(candidateIdentityKeys.id, k.id));
    }

    // Tombstone, not delete: undo restores the marker to null.
    await tx
      .update(candidates)
      .set({ mergedIntoId: survivor.id })
      .where(eq(candidates.id, absorbed.id));

    // A pending suggestion whose pair involved either side can no longer be
    // decided — flip it stale in the same transaction (design §1.4).
    await tx
      .update(candidateMergeSuggestions)
      .set({ status: "stale" })
      .where(
        and(
          eq(candidateMergeSuggestions.orgId, orgId),
          eq(candidateMergeSuggestions.status, "pending"),
          or(
            inArray(candidateMergeSuggestions.candidateAId, [survivor.id, absorbed.id]),
            inArray(candidateMergeSuggestions.candidateBId, [survivor.id, absorbed.id]),
          ),
        ),
      );

    const [mergeRow] = await tx
      .insert(candidateMerges)
      .values({
        orgId,
        survivorId: survivor.id,
        mergedId: absorbed.id,
        undoSnapshot: snapshot,
        createdBy: actor.userId ?? null,
      })
      .returning();
    if (!mergeRow) throw new Error("Merge record insert failed.");

    if (opts.suggestionId) {
      await tx
        .update(candidateMergeSuggestions)
        .set({
          status: "merged",
          decidedBy: actor.userId ?? null,
          decidedAt: new Date(),
          decisionNote: opts.decisionNote ?? null,
          mergeId: mergeRow.id,
        })
        .where(
          and(
            eq(candidateMergeSuggestions.id, opts.suggestionId),
            eq(candidateMergeSuggestions.orgId, orgId),
          ),
        );
    }

    // The merge may drop agent requests about the absorbed row's applications.
    const { afterSubjectsDeleted } = await import("../agents/runtime.server");
    await afterSubjectsDeleted(orgId);

    void writeMergeAudit(actor, orgId, "candidate.merge", mergeRow.id, {
      survivorId: survivor.id,
      mergedId: absorbed.id,
      movedChildren,
      deletedChildren,
      fromSuggestion: opts.suggestionId ?? null,
    });

    return {
      mergeId: mergeRow.id,
      survivorId: survivor.id,
      mergedId: absorbed.id,
      movedChildren,
      deletedChildren,
    };
  });
}

/* ------------------------------------------------------------------ undo */

export type UndoResult = { undone: true; mergeId: string };

/**
 * Undo a merge. Refused — with the reason — when any re-pointed child changed
 * after the merge (M0 finding 4): un-merging a moved application would
 * corrupt the pipeline. Rows created on the survivor after the merge are
 * untouched and stay there.
 */
export async function undoMerge(opts: {
  orgId: string;
  mergeId: string;
  actor: MergeActor;
  note?: string | null;
}): Promise<UndoResult> {
  const [mergeRow] = await db
    .select()
    .from(candidateMerges)
    .where(and(eq(candidateMerges.id, opts.mergeId), eq(candidateMerges.orgId, opts.orgId)))
    .limit(1);
  if (!mergeRow) throw new Error("Merge not found in your organisation.");
  if (mergeRow.undoneAt) throw new Error("This merge has already been undone.");

  const snapshot = mergeRow.undoSnapshot;
  const absorbedId = snapshot.absorbed.id;

  await db.transaction(async (tx) => {
    // Re-insert rows the merge deleted outright, original ids and dates (M0 Q4).
    // Timestamps come back from the jsonb snapshot as strings — drizzle's
    // timestamp columns need Dates.
    for (const d of snapshot.deleted) {
      const row = { ...d.row } as Record<string, unknown>;
      for (const col of ["appliedAt", "lastActivityAt"]) {
        const v = row[col];
        if (typeof v === "string") row[col] = new Date(v);
      }
      await tx.insert(applications).values(row as typeof applications.$inferInsert);
    }
    // Re-point back — but only children that have not changed since.
    const descriptors = childDescriptors(tx, opts.orgId);
    for (const r of snapshot.repointed) {
      if (r.table === getTableName(applications)) {
        const [current] = await tx
          .select()
          .from(applications)
          .where(eq(applications.id, r.row["id"] as string))
          .limit(1);
        assertUnchanged("applications", current, r.row);
        await tx
          .update(applications)
          .set({ candidateId: absorbedId })
          .where(eq(applications.id, r.row["id"] as string));
        continue;
      }
      const d = descriptors.find((x) => x.name === r.table);
      if (!d)
        throw new Error(`This merge can no longer be undone: unknown child table ${r.table}.`);
      const current = await d.get(r.row["id"] as string);
      assertUnchanged(r.table, current, r.row);
      await d.repoint(r.row["id"] as string, absorbedId);
    }
    // Keys back to the absorbed row.
    for (const k of snapshot.keys) {
      await tx
        .update(candidateIdentityKeys)
        .set({ candidateId: absorbedId })
        .where(
          and(
            eq(candidateIdentityKeys.orgId, opts.orgId),
            eq(candidateIdentityKeys.candidateId, mergeRow.survivorId),
            eq(candidateIdentityKeys.keyType, k.keyType),
            eq(candidateIdentityKeys.keyValue, k.keyValue),
          ),
        );
    }
    await tx.update(candidates).set({ mergedIntoId: null }).where(eq(candidates.id, absorbedId));
    await tx
      .update(candidateMerges)
      .set({
        undoneBy: opts.actor.userId ?? null,
        undoneAt: new Date(),
        undoNote: opts.note ?? null,
      })
      .where(eq(candidateMerges.id, mergeRow.id));
  });

  void writeMergeAudit(opts.actor, opts.orgId, "candidate.merge.undo", opts.mergeId, {
    survivorId: mergeRow.survivorId,
    mergedId: absorbedId,
  });
  return { undone: true, mergeId: opts.mergeId };
}

function assertUnchanged(
  table: string,
  current: Record<string, unknown> | undefined,
  before: Record<string, unknown>,
) {
  if (!current)
    throw new Error(
      "This merge can no longer be undone: a moved record was deleted after the merge.",
    );
  if (fingerprintOf(table, current) !== fingerprintOf(table, before))
    throw new Error(
      "This merge can no longer be undone: a moved record changed after the merge. Resolve that record manually.",
    );
}

/* ------------------------------------------------------------- decisions */

export type DecideResult = { status: "merged" | "kept_separate"; mergeId?: string };

/**
 * Decide a pending suggestion. `merge` runs the reversible merge (survivor
 * defaults to the oldest row; an explicit survivorId lets the reviewer swap);
 * `keep_separate` keeps both rows and demotes the collision keys to shared_*
 * on the newcomer so the same contact never auto-merges anyone again
 * (M0 finding 1).
 */
export async function decideSuggestion(opts: {
  orgId: string;
  suggestionId: string;
  decision: "merge" | "keep_separate";
  survivorId?: string | null;
  note?: string | null;
  actor: MergeActor;
}): Promise<DecideResult> {
  const [suggestion] = await db
    .select()
    .from(candidateMergeSuggestions)
    .where(
      and(
        eq(candidateMergeSuggestions.id, opts.suggestionId),
        eq(candidateMergeSuggestions.orgId, opts.orgId),
      ),
    )
    .limit(1);
  if (!suggestion) throw new Error("Suggestion not found in your organisation.");
  if (suggestion.status !== "pending") throw new Error("That suggestion has already been decided.");

  if (opts.decision === "merge") {
    let survivorId = opts.survivorId ?? null;
    if (!survivorId) {
      const pair = await db
        .select({ id: candidates.id, createdAt: candidates.createdAt })
        .from(candidates)
        .where(
          and(
            eq(candidates.orgId, opts.orgId),
            inArray(candidates.id, [suggestion.candidateAId, suggestion.candidateBId]),
          ),
        );
      survivorId =
        pair.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]?.id ?? null;
    }
    if (!survivorId) throw new Error("Suggestion pair not found in your organisation.");
    const mergedId =
      survivorId === suggestion.candidateAId ? suggestion.candidateBId : suggestion.candidateAId;
    const result = await mergeCandidatesCore({
      orgId: opts.orgId,
      survivorId,
      mergedId,
      actor: opts.actor,
      suggestionId: suggestion.id,
      decisionNote: opts.note ?? null,
    });
    return { status: "merged", mergeId: result.mergeId };
  }

  const newcomerId = suggestion.candidateBId;
  const sharedKeys: NewKey[] = [];
  for (const r of suggestion.reasons) {
    const m = r.signal.match(/^strong_key:(\w+)$/);
    if (!m) continue;
    const shared = sharedTypeOf(m[1] as KeyRow["keyType"]);
    if (shared) sharedKeys.push({ keyType: shared, keyValue: r.detail });
  }
  if (sharedKeys.length > 0) {
    // A shared key may already be recorded for this candidate — no-op then.
    await db
      .insert(candidateIdentityKeys)
      .values(sharedKeys.map((k) => ({ orgId: opts.orgId, candidateId: newcomerId, ...k })))
      .onConflictDoNothing();
  }
  await db
    .update(candidateMergeSuggestions)
    .set({
      status: "kept_separate",
      decidedBy: opts.actor.userId ?? null,
      decidedAt: new Date(),
      decisionNote: opts.note ?? null,
    })
    .where(
      and(
        eq(candidateMergeSuggestions.id, opts.suggestionId),
        eq(candidateMergeSuggestions.orgId, opts.orgId),
      ),
    );
  void writeMergeAudit(
    opts.actor,
    opts.orgId,
    "candidate.merge.suggestion_decided",
    opts.suggestionId,
    {
      decision: "kept_separate",
      candidateAId: suggestion.candidateAId,
      candidateBId: suggestion.candidateBId,
      sharedKeys: sharedKeys.length,
    },
  );
  return { status: "kept_separate" };
}

/* ----------------------------------------------------------------- audit */

function writeMergeAudit(
  actor: MergeActor,
  orgId: string,
  action: string,
  entityId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  return writeAudit({
    actor: actor.system
      ? `system:${actor.system}`
      : actor.userId
        ? `user:${actor.userId}`
        : (actor.email ?? "unknown"),
    orgId,
    actorUserId: actor.userId ?? null,
    action,
    entityType: "candidate",
    entityId,
    detail,
  });
}
