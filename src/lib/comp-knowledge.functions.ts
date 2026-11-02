/**
 * Org-scoped reads and writes of in-house compensation knowledge. Each call is
 * predicated on the caller's organisation (`requireOrg`); writes are audited.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { compKnowledge } from "@db/schema";
import { requireOrg } from "./auth.middleware";
import { writeAudit } from "../server/audit";
import { assertRequisitionInOrg } from "../server/guards";
import {
  readOrgKnowledge,
  readRoleKnowledge,
  roleKey,
  type CompKnowledgeEntry,
} from "./comp-knowledge.server";

export type { CompKnowledgeEntry } from "./comp-knowledge.server";

const SaveInput = z.object({
  title: z.string().min(2).max(160),
  location: z.string().max(160).nullish(),
  levelKey: z.string().min(1).max(40),
  currency: z.string().min(1).max(8).default("INR"),
  low: z.coerce.number().min(0).nullish(),
  median: z.coerce.number().min(1),
  high: z.coerce.number().min(0).nullish(),
  experienceMin: z.coerce.number().int().min(0).max(60).nullish(),
  experienceMax: z.coerce.number().int().min(0).max(60).nullish(),
  source: z.enum(["user_override", "market_applied"]).default("user_override"),
  note: z.string().max(400).nullish(),
  requisitionId: z.string().uuid().nullish(),
});

/**
 * Store a pay figure the organisation has decided on. Future benchmark runs
 * read these back as in-house evidence, so the recommendation drifts towards
 * the organisation's own reality instead of restarting from the open web.
 */
export const saveCompFigure = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }): Promise<CompKnowledgeEntry[]> => {
    if (data.requisitionId) await assertRequisitionInOrg(data.requisitionId, context.orgId);

    const ordered = [data.low ?? data.median, data.median, data.high ?? data.median]
      .map((n) => Math.max(0, Math.round(Number(n) || 0)))
      .sort((a, b) => a - b);

    await db.insert(compKnowledge).values({
      orgId: context.orgId,
      requisitionId: data.requisitionId ?? null,
      roleKey: roleKey(data.title),
      title: data.title.trim(),
      location: data.location?.trim() || null,
      levelKey: data.levelKey,
      currency: data.currency,
      low: String(ordered[0] ?? 0),
      median: String(ordered[1] ?? 0),
      high: String(ordered[2] ?? 0),
      experienceMin: data.experienceMin ?? null,
      experienceMax: data.experienceMax ?? null,
      source: data.source,
      note: data.note?.trim() || null,
      createdBy: context.userId,
    });

    await writeAudit({
      actor: context.memberEmail,
      actorUserId: context.userId,
      orgId: context.orgId,
      action: "comp_knowledge.save",
      entityType: "comp_knowledge",
      entityId: data.requisitionId ?? null,
      detail: {
        title: data.title,
        level: data.levelKey,
        median: ordered[1],
        currency: data.currency,
        source: data.source,
      },
    });

    return readRoleKnowledge(context.orgId, data.title);
  });

const RoleInput = z.object({ title: z.string().min(1).max(160) });

/** Saved figures for one role. */
export const listRoleCompKnowledge = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) => RoleInput.parse(data))
  .handler(({ data, context }) => readRoleKnowledge(context.orgId, data.title));

/** Everything the organisation has saved, newest first. */
export const listOrgCompKnowledge = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(({ context }) => readOrgKnowledge(context.orgId));
