/**
 * Archive import (plan rows 3–4, A3; docs/candidate-identification/track-a-design.md §3).
 *
 * A recruiter stages files into an import; the cron tick drains items:
 * reclaim expired leases → claim with SKIP LOCKED → per item: spend-cap check
 * (defer without burning an attempt) → read the staged bytes → extract text in
 * the parser sandbox → skip a file this organisation already holds → ingest
 * through the shared intake core (identity resolution + CV version + claims
 * queue) → delete the staged bytes. Re-running is idempotent: files are keyed
 * by sha256 within an import and against the organisation's file-hash keys.
 *
 * Trial runs process up to `trialLimit` files without writing candidates: they
 * record parse quality and the identity outcome per file, so the report can be
 * read before the real import.
 *
 * Staged files hold personal data with no owning candidate row, so every
 * terminal state deletes them and a finished import sweeps its whole prefix.
 */
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import {
  candidateCvVersions,
  aiUsageEvents,
  candidateArchiveImports,
  candidateArchiveItems,
  candidateIdentityKeys,
  type ArchiveItemStatus,
} from "@db/schema";
import { db } from "../db";
import { log } from "../log";
import { deleteObject, deletePrefix, getObject, putObject, safeFileName } from "../storage";

export const ARCHIVE_MAX_FILE_BYTES = 15_000_000;
export const ARCHIVE_ALLOWED = /\.(pdf|docx|txt|rtf)$/i;
export const ARCHIVE_MAX_ATTEMPTS = 3;
const LEASE_MS = 5 * 60_000;
/** Text shorter than this is treated as unreadable (scanned or empty). */
const MIN_TEXT = 80;

const TERMINAL: ArchiveItemStatus[] = ["done", "merged", "needs_review", "skipped", "failed"];

/** Vendor-neutral failure reasons shown to recruiters (never provider text). */
export const ARCHIVE_REASON = {
  unreadable: "No readable text (scanned or image-only file)",
  missing: "Staged file is no longer available",
  tooLarge: "File is larger than 15 MB",
  type: "Unsupported file type",
  already: "Already in the talent pool",
  failed: "Could not be processed",
} as const;

export function stagedPrefix(orgId: string, importId: string): string {
  return `${orgId}/archive-import/${importId}/`;
}

export async function stageArchiveFile(input: {
  orgId: string;
  importId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<{ status: "staged" | "duplicate" | "rejected"; reason?: string }> {
  if (!ARCHIVE_ALLOWED.test(input.fileName))
    return { status: "rejected", reason: ARCHIVE_REASON.type };
  if (input.bytes.byteLength > ARCHIVE_MAX_FILE_BYTES)
    return { status: "rejected", reason: ARCHIVE_REASON.tooLarge };
  if (input.bytes.byteLength === 0)
    return { status: "rejected", reason: ARCHIVE_REASON.unreadable };
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const [dupe] = await db
    .select({ id: candidateArchiveItems.id })
    .from(candidateArchiveItems)
    .where(
      and(
        eq(candidateArchiveItems.orgId, input.orgId),
        eq(candidateArchiveItems.importId, input.importId),
        eq(candidateArchiveItems.fileHash, hash),
      ),
    )
    .limit(1);
  if (dupe) return { status: "duplicate" };
  const path = `${stagedPrefix(input.orgId, input.importId)}${hash.slice(0, 16)}-${safeFileName(input.fileName)}`;
  const { contentTypeFor } = await import("../storage");
  await putObject(path, input.bytes, contentTypeFor(safeFileName(input.fileName)));
  const inserted = await db
    .insert(candidateArchiveItems)
    .values({
      orgId: input.orgId,
      importId: input.importId,
      fileName: input.fileName.slice(0, 255),
      fileHash: hash,
      fileSize: input.bytes.byteLength,
      stagedPath: path,
    })
    .onConflictDoNothing()
    .returning({ id: candidateArchiveItems.id });
  if (!inserted.length) {
    await deleteObject(path).catch(() => undefined);
    return { status: "duplicate" };
  }
  return { status: "staged" };
}

type Claimed = {
  id: string;
  org_id: string;
  import_id: string;
  file_name: string;
  file_hash: string;
  staged_path: string | null;
  attempts: number;
  trial_run: boolean;
};

/** Drain archive items across running imports. */
export async function drainArchiveImports(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = { claimed: 0, deferred: 0 };
  const now = new Date();
  await db
    .update(candidateArchiveItems)
    .set({ status: "pending", leaseUntil: null })
    .where(
      and(eq(candidateArchiveItems.status, "running"), lt(candidateArchiveItems.leaseUntil, now)),
    );

  // Trial imports only take as many files as their limit allows.
  const result = (await db.execute(sql`
    update candidate_archive_items i set status = 'running',
      lease_until = ${new Date(Date.now() + LEASE_MS).toISOString()}::timestamptz,
      attempts = i.attempts + 1, updated_at = now()
    from candidate_archive_imports m
    where i.import_id = m.id and i.id in (
      select it.id from candidate_archive_items it
      join candidate_archive_imports im on im.id = it.import_id
      where it.status = 'pending' and im.status = 'running'
        and (not im.trial_run or it.id in (
          select x.id from candidate_archive_items x
          where x.import_id = im.id and x.status = 'pending'
          order by x.created_at
          limit greatest(coalesce(im.trial_limit, 250) - (
            select count(*) from candidate_archive_items y
            where y.import_id = im.id and y.status <> 'pending'
          ), 0)
        ))
      order by it.created_at
      limit ${opts.limit ?? 10}
      for update of it skip locked
    )
    returning i.id, i.org_id, i.import_id, i.file_name, i.file_hash, i.staged_path, i.attempts, m.trial_run
  `)) as unknown as { rows?: Claimed[] } | Claimed[];
  const items: Claimed[] = Array.isArray(result) ? result : (result.rows ?? []);
  counts["claimed"] = items.length;

  if (items.length) {
    const { spendCapRefusal } = await import("../ai-spend-cap");
    const capped = new Map<string, boolean>();
    for (const org of new Set(items.map((i) => i.org_id)))
      capped.set(org, Boolean(await spendCapRefusal(org)));
    const queue = [...items];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        if (capped.get(it.org_id)) {
          await db
            .update(candidateArchiveItems)
            .set({
              status: "pending",
              leaseUntil: null,
              attempts: sql`greatest(${candidateArchiveItems.attempts} - 1, 0)`,
            })
            .where(eq(candidateArchiveItems.id, it.id));
          counts["deferred"]!++;
          continue;
        }
        const outcome = await processItem(it).catch(async (e: unknown) => {
          log.warn("archive.item_failed", { org_id: it.org_id, item_id: it.id, error: e as Error });
          const final = it.attempts >= ARCHIVE_MAX_ATTEMPTS;
          if (final) {
            await finishItem(it, "failed", { detail: ARCHIVE_REASON.failed });
            return "failed" as const;
          }
          await db
            .update(candidateArchiveItems)
            .set({ status: "pending", leaseUntil: null, updatedAt: new Date() })
            .where(eq(candidateArchiveItems.id, it.id));
          return "retry" as const;
        });
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, worker));
  }

  await closeFinishedImports();
  return counts;
}

async function processItem(it: Claimed): Promise<ArchiveItemStatus | "retry"> {
  const staged = it.staged_path ? await getObject(it.staged_path) : null;
  if (!staged) {
    await finishItem(it, "failed", { detail: ARCHIVE_REASON.missing });
    return "failed";
  }

  // This organisation already holds these exact bytes: nothing to import.
  const [held] = await db
    .select({ candidateId: candidateIdentityKeys.candidateId })
    .from(candidateIdentityKeys)
    .where(
      and(
        eq(candidateIdentityKeys.orgId, it.org_id),
        eq(candidateIdentityKeys.keyType, "file_hash"),
        eq(candidateIdentityKeys.keyValue, it.file_hash),
      ),
    )
    .limit(1);
  if (held && !it.trial_run) {
    await finishItem(it, "skipped", {
      detail: ARCHIVE_REASON.already,
      candidateId: held.candidateId,
    });
    return "skipped";
  }

  const { attachmentText } = await import("@/lib/cv-text.server");
  const text = (await attachmentText(it.file_name, staged.bytes)).trim();
  if (text.length < MIN_TEXT) {
    // An empty result can also mean the parser was unavailable: retry first.
    if (it.attempts < ARCHIVE_MAX_ATTEMPTS) {
      await db
        .update(candidateArchiveItems)
        .set({ status: "pending", leaseUntil: null, updatedAt: new Date() })
        .where(eq(candidateArchiveItems.id, it.id));
      return "retry";
    }
    await finishItem(it, "failed", { detail: ARCHIVE_REASON.unreadable });
    return "failed";
  }

  if (it.trial_run) {
    const { parseCv } = await import("@/lib/intake.server");
    const { resolveIdentity } = await import("./identity.server");
    const p = await parseCv(text, it.org_id);
    const identityInput = {
      orgId: it.org_id,
      fullName: p?.full_name ?? "",
      email: p?.email ?? null,
      phone: p?.phone ?? null,
      linkedinUrl: p?.linkedin_url ?? null,
      githubUrl: p?.github_url ?? null,
      fileHash: it.file_hash,
      education: p?.education ?? null,
      location: p?.location ?? null,
      employmentHistory: (p?.employment_history ?? []).map((h) => ({
        company: h.company,
        start: h.start,
        title: h.title,
      })),
    };
    const outcome = await resolveIdentity(identityInput);
    // The trial writes no keys, so in-batch duplicates are found by comparing
    // hashed strong keys between trial files (no raw contact data is stored).
    const { computeIdentityKeys } = await import("@/lib/candidates/identity-normalise");
    const { createHash } = await import("node:crypto");
    const keyHashes = computeIdentityKeys(identityInput, null)
      .filter((k) => ["email", "phone", "linkedin", "github"].includes(k.keyType))
      .map((k) =>
        createHash("sha256")
          .update(`${it.org_id}|${k.keyType}|${k.keyValue}`)
          .digest("hex")
          .slice(0, 24),
      );
    await finishItem(it, "skipped", {
      trial: {
        textChars: text.length,
        parsed: Boolean(p),
        hasName: Boolean(p?.full_name),
        hasEmail: Boolean(p?.email),
        hasPhone: Boolean(p?.phone),
        roles: p?.employment_history?.length ?? 0,
        skills: p?.skills?.length ?? 0,
        identity: outcome.outcome,
        alreadyHeld: Boolean(held),
        keyHashes,
      },
    });
    return "skipped";
  }

  const { ingestCandidate } = await import("@/lib/intake.server");
  const res = await ingestCandidate({
    resumeText: text,
    fileName: it.file_name,
    requisitionId: null,
    orgId: it.org_id,
    source: "archive_import",
    resumeFile: { filename: it.file_name, bytes: staged.bytes },
  });
  // A retry of an attempt that was interrupted after creating the candidate
  // (before the file fingerprint was saved) "merges" into that same candidate:
  // it holds no CV other than this file, so the file was imported, not merged.
  let merged = res.merged;
  if (merged && res.candidateId) {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(candidateCvVersions)
      .where(
        and(
          eq(candidateCvVersions.orgId, it.org_id),
          eq(candidateCvVersions.candidateId, res.candidateId),
          sql`${candidateCvVersions.fileHash} is distinct from ${it.file_hash}`,
        ),
      );
    if (n === 0) merged = false;
  }
  const status: ArchiveItemStatus = res.reviewQueued ? "needs_review" : merged ? "merged" : "done";
  await finishItem(it, status, { candidateId: res.candidateId });
  return status;
}

async function finishItem(
  it: Pick<Claimed, "id" | "staged_path">,
  status: ArchiveItemStatus,
  extra: { detail?: string; candidateId?: string | null; trial?: Record<string, unknown> } = {},
) {
  if (it.staged_path) await deleteObject(it.staged_path);
  await db
    .update(candidateArchiveItems)
    .set({
      status,
      stagedPath: null,
      leaseUntil: null,
      updatedAt: new Date(),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(extra.candidateId !== undefined ? { candidateId: extra.candidateId } : {}),
      ...(extra.trial !== undefined ? { trial: extra.trial } : {}),
    })
    .where(eq(candidateArchiveItems.id, it.id));
}

/**
 * An import with nothing left to do is done: trial runs stop at their limit
 * (remaining items are skipped unread), and the whole staged prefix is swept so
 * no personal data outlives the import.
 */
async function closeFinishedImports() {
  const running = await db
    .select({
      id: candidateArchiveImports.id,
      orgId: candidateArchiveImports.orgId,
      trialRun: candidateArchiveImports.trialRun,
      trialLimit: candidateArchiveImports.trialLimit,
    })
    .from(candidateArchiveImports)
    .where(eq(candidateArchiveImports.status, "running"));
  for (const imp of running) {
    const rows = await db
      .select({ status: candidateArchiveItems.status, n: sql<number>`count(*)::int` })
      .from(candidateArchiveItems)
      .where(eq(candidateArchiveItems.importId, imp.id))
      .groupBy(candidateArchiveItems.status);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
    const open = (by["pending"] ?? 0) + (by["running"] ?? 0);
    const processed = rows.reduce((a, r) => a + r.n, 0) - open;
    const trialDone = imp.trialRun && processed >= (imp.trialLimit ?? 250) && !by["running"];
    if (open > 0 && !trialDone) continue;
    await finaliseImport(imp.orgId, imp.id, "done");
  }
}

/** Close an import: unprocessed items are skipped, staged bytes swept. */
export async function finaliseImport(
  orgId: string,
  importId: string,
  status: "done" | "cancelled",
): Promise<void> {
  await db
    .update(candidateArchiveItems)
    .set({ status: "skipped", stagedPath: null, leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(candidateArchiveItems.orgId, orgId),
        eq(candidateArchiveItems.importId, importId),
        inArray(candidateArchiveItems.status, ["pending"]),
      ),
    );
  await deletePrefix(stagedPrefix(orgId, importId));
  await db
    .update(candidateArchiveImports)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(candidateArchiveImports.id, importId), eq(candidateArchiveImports.orgId, orgId)));
  const { writeAudit } = await import("../audit");
  void writeAudit({
    actor: "system",
    orgId,
    action:
      status === "done"
        ? "candidate.archive_import.finished"
        : "candidate.archive_import.cancelled",
    entityType: "candidate_archive_import",
    entityId: importId,
  });
}

export type ArchiveImportView = {
  id: string;
  name: string;
  status: string;
  trialRun: boolean;
  trialLimit: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: Record<ArchiveItemStatus, number> & { total: number };
  report: TrialReport | null;
};

export type TrialReport = {
  processed: number;
  readable: number;
  parsed: number;
  withEmail: number;
  withPhone: number;
  /** Strong-key or review matches per 100 files (within the org and earlier trial files). */
  duplicateRate: number;
  aiCalls: number;
  promptTokens: number;
  completionTokens: number;
};

export async function listArchiveImports(orgId: string): Promise<ArchiveImportView[]> {
  const imports = await db
    .select()
    .from(candidateArchiveImports)
    .where(eq(candidateArchiveImports.orgId, orgId))
    .orderBy(sql`${candidateArchiveImports.createdAt} desc`)
    .limit(20);
  if (!imports.length) return [];
  const rows = await db
    .select({
      importId: candidateArchiveItems.importId,
      status: candidateArchiveItems.status,
      n: sql<number>`count(*)::int`,
    })
    .from(candidateArchiveItems)
    .where(
      and(
        eq(candidateArchiveItems.orgId, orgId),
        inArray(
          candidateArchiveItems.importId,
          imports.map((i) => i.id),
        ),
      ),
    )
    .groupBy(candidateArchiveItems.importId, candidateArchiveItems.status);
  const out: ArchiveImportView[] = [];
  for (const imp of imports) {
    const counts = {
      pending: 0,
      running: 0,
      done: 0,
      merged: 0,
      needs_review: 0,
      skipped: 0,
      failed: 0,
      total: 0,
    };
    for (const r of rows.filter((x) => x.importId === imp.id)) {
      counts[r.status] = r.n;
      counts.total += r.n;
    }
    out.push({
      id: imp.id,
      name: imp.name,
      status: imp.status,
      trialRun: imp.trialRun,
      trialLimit: imp.trialLimit,
      createdAt: imp.createdAt.toISOString(),
      startedAt: imp.startedAt?.toISOString() ?? null,
      finishedAt: imp.finishedAt?.toISOString() ?? null,
      counts,
      report: imp.trialRun ? await trialReport(orgId, imp) : null,
    });
  }
  return out;
}

async function trialReport(
  orgId: string,
  imp: typeof candidateArchiveImports.$inferSelect,
): Promise<TrialReport> {
  const items = await db
    .select({ status: candidateArchiveItems.status, trial: candidateArchiveItems.trial })
    .from(candidateArchiveItems)
    .where(and(eq(candidateArchiveItems.orgId, orgId), eq(candidateArchiveItems.importId, imp.id)));
  const done = items.filter((i) => i.trial);
  const t = done.map((i) => i.trial as Record<string, unknown>);
  // Duplicates: matches against people the organisation already holds, plus
  // files in this trial sharing a strong key with an earlier trial file.
  const seen = new Set<string>();
  let dupes = 0;
  for (const x of t) {
    const hashes = (x["keyHashes"] as string[] | undefined) ?? [];
    const inBatch = hashes.some((h) => seen.has(h));
    for (const h of hashes) seen.add(h);
    if (
      inBatch ||
      x["alreadyHeld"] ||
      ["merged", "attach", "review"].includes(String(x["identity"]))
    )
      dupes++;
  }
  // AI usage for this org while the trial ran (the pilot org runs nothing else).
  const [usage] = imp.startedAt
    ? await db
        .select({
          calls: sql<number>`count(*)::int`,
          prompt: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}),0)::int`,
          completion: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}),0)::int`,
        })
        .from(aiUsageEvents)
        .where(
          and(
            eq(aiUsageEvents.orgId, orgId),
            eq(aiUsageEvents.feature, "resume_parse"),
            gte(aiUsageEvents.createdAt, imp.startedAt),
            lte(aiUsageEvents.createdAt, imp.finishedAt ?? new Date()),
          ),
        )
    : [];
  const processed = items.filter(
    (i) => TERMINAL.includes(i.status) && (i.trial || i.status === "failed"),
  ).length;
  return {
    processed,
    readable: t.length,
    parsed: t.filter((x) => x["parsed"]).length,
    withEmail: t.filter((x) => x["hasEmail"]).length,
    withPhone: t.filter((x) => x["hasPhone"]).length,
    duplicateRate: t.length ? Math.round((dupes / t.length) * 1000) / 10 : 0,
    aiCalls: usage?.calls ?? 0,
    promptTokens: usage?.prompt ?? 0,
    completionTokens: usage?.completion ?? 0,
  };
}

/** CSV of the files that need a person: failed and needs-review items. */
export async function archiveIssuesCsv(orgId: string, importId: string): Promise<string> {
  const rows = await db
    .select({
      fileName: candidateArchiveItems.fileName,
      status: candidateArchiveItems.status,
      detail: candidateArchiveItems.detail,
      candidateId: candidateArchiveItems.candidateId,
    })
    .from(candidateArchiveItems)
    .where(
      and(
        eq(candidateArchiveItems.orgId, orgId),
        eq(candidateArchiveItems.importId, importId),
        inArray(candidateArchiveItems.status, ["failed", "needs_review"]),
      ),
    );
  const esc = (v: string | null) => `"${(v ?? "").replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`;
  return [
    "file,status,reason,candidate_id",
    ...rows.map((r) => [esc(r.fileName), r.status, esc(r.detail), r.candidateId ?? ""].join(",")),
  ].join("\n");
}
