/**
 * Agent studio server functions (docs/agent-studio.md): customise a stock
 * agent for use outside this app, download it as a portable package, and
 * issue hosted-API keys. Reads need org membership; every change needs the
 * HR head or President / CBO (owner passes) and is audited. Every query is
 * scoped to the caller's organisation.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { agentExportKeys, agentExports, userRoles, type AgentType } from "@db/schema";
import { db } from "../server/db";
import { requireOrg } from "./auth.middleware";

const STUDIO_ROLES = ["hr_head", "president_cbo"] as const;

async function canEditStudio(ctx: { userId: string; orgId: string; isOwner: boolean }) {
  if (ctx.isOwner) return true;
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, ctx.userId), eq(userRoles.orgId, ctx.orgId)));
  return rows.some((r) => (STUDIO_ROLES as readonly string[]).includes(r.role));
}

async function assertStudioRole(ctx: { userId: string; orgId: string }) {
  const { assertRole } = await import("./auth.middleware");
  await assertRole(ctx.userId, ctx.orgId, [...STUDIO_ROLES]);
}

async function audit(
  ctx: { userId: string; orgId: string },
  action: string,
  entityId: string,
  detail: unknown,
) {
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${ctx.userId}`,
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    action,
    entityType: "agent_export",
    entityId,
    detail,
  });
}

export type StudioAgent = {
  type: string;
  name: string;
  version: string;
  responsibility: string;
  instructions: string;
  mustNever: string[];
  tools: { name: string; description: string }[];
  maxSteps: number;
  maxTokens: number | null;
};

export type StudioExport = {
  id: string;
  agentType: string;
  name: string;
  description: string;
  extraInstructions: string;
  tools: string[];
  extraMustNever: string[];
  maxSteps: number | null;
  maxTokens: number | null;
  status: "draft" | "published" | "archived";
  version: number;
  baseVersion: string;
  outOfDate: boolean;
  updatedAt: string;
  keys: {
    id: string;
    label: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
};

export type StudioView = { canEdit: boolean; agents: StudioAgent[]; exports: StudioExport[] };

export const agentStudio = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<StudioView> => {
    const { ensureAgentsRegistered } = await import("../server/agents");
    ensureAgentsRegistered();
    const { listAgents, getAgent, getTool } = await import("../server/agents/registry");
    const { isOutOfDate } = await import("../server/agents/exports.server");
    const [rows, keys] = await Promise.all([
      db
        .select()
        .from(agentExports)
        .where(eq(agentExports.orgId, context.orgId))
        .orderBy(desc(agentExports.updatedAt)),
      db
        .select()
        .from(agentExportKeys)
        .where(and(eq(agentExportKeys.orgId, context.orgId), isNull(agentExportKeys.revokedAt)))
        .orderBy(desc(agentExportKeys.createdAt)),
    ]);
    const agents = listAgents()
      .filter((d) => d.tools.length > 0)
      .map((d) => ({
        type: d.type,
        name: d.name,
        version: d.version,
        responsibility: d.responsibility,
        instructions: d.system,
        mustNever: d.mustNever,
        tools: d.tools.map((name) => ({ name, description: getTool(name)?.description ?? "" })),
        maxSteps: d.maxSteps ?? 20,
        maxTokens: d.maxTokens ?? null,
      }));
    return {
      canEdit: await canEditStudio(context),
      agents,
      exports: rows.map((r) => {
        const def = getAgent(r.agentType);
        return {
          id: r.id,
          agentType: r.agentType,
          name: r.name,
          description: r.description,
          extraInstructions: r.extraInstructions,
          tools: r.tools,
          extraMustNever: r.extraMustNever,
          maxSteps: r.maxSteps,
          maxTokens: r.maxTokens,
          status: r.status,
          version: r.version,
          baseVersion: r.baseVersion,
          outOfDate: def ? isOutOfDate(def, r) : true,
          updatedAt: r.updatedAt.toISOString(),
          keys: keys
            .filter((k) => k.exportId === r.id)
            .map((k) => ({
              id: k.id,
              label: k.label,
              prefix: k.keyPrefix,
              createdAt: k.createdAt.toISOString(),
              lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
            })),
        };
      }),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  agentType: z.string().min(1).max(40),
  name: z.string().max(80),
  description: z.string().max(500),
  extraInstructions: z.string().max(4000),
  tools: z.array(z.string().max(80)).max(60),
  extraMustNever: z.array(z.string().max(300)).max(20),
  maxSteps: z.number().int().nullable(),
  maxTokens: z.number().int().nullable(),
  status: z.enum(["draft", "published"]),
});

export type SaveAgentExportInput = z.infer<typeof SaveInput>;

/** Create or update an export. Saving re-bases it on the current stock agent. */
export const saveAgentExport = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    await assertStudioRole(context);
    const { ensureAgentsRegistered } = await import("../server/agents");
    ensureAgentsRegistered();
    const { getAgent } = await import("../server/agents/registry");
    const { manifestHash } = await import("../server/agents/manifest.server");
    const { exportProblem, loadExport } = await import("../server/agents/exports.server");
    const def = getAgent(data.agentType as AgentType);
    if (!def) throw new Error("Unknown agent.");
    const fields = {
      name: data.name.trim(),
      description: data.description.trim(),
      extraInstructions: data.extraInstructions.trim(),
      tools: data.tools,
      extraMustNever: data.extraMustNever.map((m) => m.trim()).filter(Boolean),
      maxSteps: data.maxSteps,
      maxTokens: data.maxTokens,
    };
    const problem = exportProblem(def, fields);
    if (problem) throw new Error(problem);
    const base = { baseVersion: def.version, baseHash: manifestHash(def) };
    const now = new Date();
    if (data.id) {
      const current = await loadExport(context.orgId, data.id);
      if (!current || current.status === "archived") throw new Error("Export not found.");
      if (current.agentType !== data.agentType) throw new Error("An export keeps its agent.");
      await db
        .update(agentExports)
        .set({
          ...fields,
          ...base,
          status: data.status,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(and(eq(agentExports.id, data.id), eq(agentExports.orgId, context.orgId)));
      await audit(context, "agent.export.saved", data.id, {
        agentType: data.agentType,
        version: current.version + 1,
        status: data.status,
        tools: fields.tools,
      });
      return { id: data.id };
    }
    const [row] = await db
      .insert(agentExports)
      .values({
        orgId: context.orgId,
        agentType: def.type,
        ...fields,
        ...base,
        status: data.status,
        createdBy: context.userId,
      })
      .returning({ id: agentExports.id });
    await audit(context, "agent.export.created", row!.id, {
      agentType: def.type,
      status: data.status,
      tools: fields.tools,
    });
    return { id: row!.id };
  });

const IdInput = z.object({ id: z.string().uuid() });

/** Archive an export and revoke its keys. */
export const archiveAgentExport = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertStudioRole(context);
    const now = new Date();
    const done = await db
      .update(agentExports)
      .set({ status: "archived", updatedAt: now })
      .where(and(eq(agentExports.id, data.id), eq(agentExports.orgId, context.orgId)))
      .returning({ id: agentExports.id });
    if (!done.length) throw new Error("Export not found.");
    await db
      .update(agentExportKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(agentExportKeys.exportId, data.id),
          eq(agentExportKeys.orgId, context.orgId),
          isNull(agentExportKeys.revokedAt),
        ),
      );
    await audit(context, "agent.export.archived", data.id, {});
    return { ok: true };
  });

/** The portable package for an export, as a JSON file body. Audited. */
export const downloadAgentPackage = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<{ fileName: string; json: string }> => {
    await assertStudioRole(context);
    const { ensureAgentsRegistered } = await import("../server/agents");
    ensureAgentsRegistered();
    const { getAgent } = await import("../server/agents/registry");
    const { buildPackage, loadExport } = await import("../server/agents/exports.server");
    const exp = await loadExport(context.orgId, data.id);
    if (!exp || exp.status === "archived") throw new Error("Export not found.");
    const def = getAgent(exp.agentType);
    if (!def) throw new Error("Unknown agent.");
    const pkg = buildPackage(def, exp);
    await audit(context, "agent.export.downloaded", exp.id, { version: exp.version });
    const slug =
      exp.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "agent";
    return { fileName: `${slug}-v${exp.version}.agent.json`, json: JSON.stringify(pkg, null, 2) };
  });

const KeyInput = z.object({ exportId: z.string().uuid(), label: z.string().max(80) });

/**
 * Issue a hosted-API key for a published export. Runs started with it act as
 * the person who created it. The key is returned once and only its hash kept.
 */
export const createExportKey = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => KeyInput.parse(d))
  .handler(async ({ data, context }): Promise<{ key: string }> => {
    await assertStudioRole(context);
    const { loadExport, newKey } = await import("../server/agents/exports.server");
    const exp = await loadExport(context.orgId, data.exportId);
    if (!exp || exp.status !== "published") throw new Error("Publish the export first.");
    const k = newKey();
    const [row] = await db
      .insert(agentExportKeys)
      .values({
        orgId: context.orgId,
        exportId: exp.id,
        label: data.label.trim(),
        keyPrefix: k.prefix,
        keyHash: k.hash,
        principalUserId: context.userId,
        createdBy: context.userId,
      })
      .returning({ id: agentExportKeys.id });
    await audit(context, "agent.export.key_created", exp.id, {
      keyId: row!.id,
      prefix: k.prefix,
    });
    return { key: k.key };
  });

const RevokeInput = z.object({ keyId: z.string().uuid() });

export const revokeExportKey = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => RevokeInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertStudioRole(context);
    const done = await db
      .update(agentExportKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentExportKeys.id, data.keyId),
          eq(agentExportKeys.orgId, context.orgId),
          isNull(agentExportKeys.revokedAt),
        ),
      )
      .returning({ exportId: agentExportKeys.exportId, prefix: agentExportKeys.keyPrefix });
    if (!done.length) throw new Error("Key not found.");
    await audit(context, "agent.export.key_revoked", done[0]!.exportId, {
      keyId: data.keyId,
      prefix: done[0]!.prefix,
    });
    return { ok: true };
  });
