/**
 * Archive import server functions (A3): create an import, stage files into it
 * (batches of base64 files from the browser, which unzips archives locally),
 * start, cancel, list with progress, and the issues CSV. Recruiter-side roles
 * only; every query is org-scoped; lifecycle changes are audited.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { candidateArchiveImports } from "@db/schema";
import { db } from "../server/db";
import { assertRole, requireOrg, type AppRole } from "./auth.middleware";
import { requireCapability } from "./capabilities.server";

const RECRUITER_SIDE: AppRole[] = ["recruiter", "hr_head", "president_cbo"];
/** Per staging call: keeps request bodies well under the server limit. */
const MAX_BATCH_BYTES = 8_000_000;

async function importInOrg(orgId: string, importId: string) {
  const [imp] = await db
    .select()
    .from(candidateArchiveImports)
    .where(and(eq(candidateArchiveImports.id, importId), eq(candidateArchiveImports.orgId, orgId)))
    .limit(1);
  if (!imp) throw new Error("Import not found in your organisation.");
  return imp;
}

async function audit(
  context: { userId: string; orgId: string; memberEmail: string },
  action: string,
  importId: string,
  detail?: unknown,
) {
  const { writeAudit } = await import("../server/audit");
  void writeAudit({
    actor: context.memberEmail,
    actorUserId: context.userId,
    orgId: context.orgId,
    action,
    entityType: "candidate_archive_import",
    entityId: importId,
    detail,
  });
}

export const listArchiveImportsFn = createServerFn({ method: "GET" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .handler(async ({ context }) => {
    const { listArchiveImports } = await import("../server/candidates/archive-import.server");
    return listArchiveImports(context.orgId);
  });

export const createArchiveImportFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(120),
        trialRun: z.boolean(),
        trialLimit: z.number().int().min(10).max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const [row] = await db
      .insert(candidateArchiveImports)
      .values({
        orgId: context.orgId,
        name: data.name,
        createdBy: context.userId,
        trialRun: data.trialRun,
        trialLimit: data.trialRun ? (data.trialLimit ?? 250) : null,
      })
      .returning({ id: candidateArchiveImports.id });
    await audit(context, "candidate.archive_import.created", row!.id, {
      trialRun: data.trialRun,
      trialLimit: data.trialLimit ?? null,
    });
    return { id: row!.id };
  });

export const stageArchiveFilesFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) =>
    z
      .object({
        importId: z.string().uuid(),
        files: z
          .array(z.object({ name: z.string().min(1).max(255), base64: z.string().min(1) }))
          .min(1)
          .max(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const imp = await importInOrg(context.orgId, data.importId);
    if (imp.status !== "staging") throw new Error("This import has already started.");
    const total = data.files.reduce((a, f) => a + Math.floor((f.base64.length * 3) / 4), 0);
    if (total > MAX_BATCH_BYTES) throw new Error("Send fewer files per batch.");
    const { stageArchiveFile } = await import("../server/candidates/archive-import.server");
    const out = { staged: 0, duplicate: 0, rejected: [] as { name: string; reason: string }[] };
    for (const f of data.files) {
      const r = await stageArchiveFile({
        orgId: context.orgId,
        importId: imp.id,
        fileName: f.name,
        bytes: new Uint8Array(Buffer.from(f.base64, "base64")),
      });
      if (r.status === "staged") out.staged++;
      else if (r.status === "duplicate") out.duplicate++;
      else out.rejected.push({ name: f.name, reason: r.reason ?? "" });
    }
    return out;
  });

export const startArchiveImportFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const imp = await importInOrg(context.orgId, data.importId);
    if (imp.status !== "staging" && imp.status !== "paused")
      throw new Error("This import cannot be started.");
    await db
      .update(candidateArchiveImports)
      .set({ status: "running", startedAt: imp.startedAt ?? new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(candidateArchiveImports.id, imp.id),
          eq(candidateArchiveImports.orgId, context.orgId),
        ),
      );
    await audit(context, "candidate.archive_import.started", imp.id);
    return { ok: true as const };
  });

export const pauseArchiveImportFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const imp = await importInOrg(context.orgId, data.importId);
    if (imp.status !== "running") throw new Error("This import is not running.");
    await db
      .update(candidateArchiveImports)
      .set({ status: "paused", updatedAt: new Date() })
      .where(
        and(
          eq(candidateArchiveImports.id, imp.id),
          eq(candidateArchiveImports.orgId, context.orgId),
        ),
      );
    await audit(context, "candidate.archive_import.paused", imp.id);
    return { ok: true as const };
  });

export const cancelArchiveImportFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, RECRUITER_SIDE);
    const imp = await importInOrg(context.orgId, data.importId);
    if (imp.status === "done" || imp.status === "cancelled")
      throw new Error("This import has already finished.");
    const { finaliseImport } = await import("../server/candidates/archive-import.server");
    await finaliseImport(context.orgId, imp.id, "cancelled");
    await audit(context, "candidate.archive_import.cancel_requested", imp.id);
    return { ok: true as const };
  });

export const archiveIssuesCsvFn = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("matching.pool")])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await importInOrg(context.orgId, data.importId);
    const { archiveIssuesCsv } = await import("../server/candidates/archive-import.server");
    return { csv: await archiveIssuesCsv(context.orgId, data.importId) };
  });
