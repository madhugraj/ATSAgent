/**
 * Bulk JD import server functions (docs/candidate-identification/track-b-design.md
 * §3–4). Every function runs behind requireOrg + the pipeline.requisitions
 * capability; the cores check roles and predicate every query on the org.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertRole, requireOrg } from "./auth.middleware";
import { requireCapability } from "./capabilities.server";

const actorOf = (c: { orgId: string; userId: string; memberEmail: string }) => ({
  orgId: c.orgId,
  userId: c.userId,
  memberEmail: c.memberEmail,
});

/** One file: extract, check for duplicates, then create or hold for review. */
export const importJdFile = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("pipeline.requisitions")])
  .validator((d: unknown) =>
    z
      .object({
        importId: z.string().uuid(),
        fileName: z.string().min(1).max(300),
        text: z.string().max(200_000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { importJdFileCore } = await import("./jd-import.server");
    return importJdFileCore(actorOf(context), data);
  });

/** The files of one import session. */
export const listJdImport = createServerFn({ method: "GET" })
  .middleware([requireOrg, requireCapability("pipeline.requisitions")])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { assertImportRole, listImportCore } = await import("./jd-import.server");
    await assertImportRole(actorOf(context));
    return listImportCore(context.orgId, data.importId);
  });

/** The recruiter decides a held file: duplicate, variant or distinct. */
export const decideJdImportItem = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("pipeline.requisitions")])
  .validator((d: unknown) =>
    z
      .object({
        itemId: z.string().uuid(),
        verdict: z.enum(["duplicate", "variant", "distinct"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { decideImportItemCore } = await import("./jd-import.server");
    return decideImportItemCore(actorOf(context), data);
  });

/** Close a session: pending reviews are discarded, created requisitions stay. */
export const closeJdImport = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("pipeline.requisitions")])
  .validator((d: unknown) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { closeImportCore } = await import("./jd-import.server");
    return closeImportCore(actorOf(context), data.importId);
  });

/** The organisation's sector taxonomy (seeded with the platform default on first read). */
export const listSectorTerms = createServerFn({ method: "GET" })
  .middleware([requireOrg, requireCapability("pipeline.requisitions")])
  .handler(async ({ context }) => {
    const { sectorTerms } = await import("./jd-import.server");
    return { terms: await sectorTerms(context.orgId) };
  });

/** Tenant governance edits the sector taxonomy; audited with before/after. */
export const saveSectorTerms = createServerFn({ method: "POST" })
  .middleware([requireOrg, requireCapability("pipeline.requisitions")])
  .validator((d: unknown) =>
    z.object({ terms: z.array(z.string().min(1).max(80)).min(1).max(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertRole(
      context.userId,
      context.orgId,
      ["hr_head", "president_cbo"],
      "Only HR or the CBO can change the sector list.",
    );
    const { sectorTerms, replaceSectorTerms } = await import("./jd-import.server");
    const before = await sectorTerms(context.orgId);
    const after = await replaceSectorTerms(context.orgId, data.terms);
    const { writeAudit } = await import("../server/audit");
    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "sector_taxonomy.updated",
      entityType: "organization",
      entityId: context.orgId,
      detail: { before, after },
    });
    return { terms: after };
  });
