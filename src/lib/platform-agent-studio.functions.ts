/**
 * Agent studio server functions — platform super admin only
 * (`requirePlatformAdmin`; docs/agent-studio.md). Blueprints adapt stock
 * agents to other domains for use in other applications; they belong to the
 * platform, never to an organisation. Every change is audited.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  agentBlueprintKeys,
  agentBlueprints,
  orgMembers,
  organizations,
  type AgentType,
} from "@db/schema";
import { db } from "../server/db";
import { requirePlatformAdmin } from "./auth.middleware";

async function audit(
  userId: string,
  action: string,
  entityId: string,
  detail: unknown,
  orgId: string | null = null,
) {
  const { writeAudit } = await import("../server/audit");
  await writeAudit({
    actor: `user:${userId}`,
    actorUserId: userId,
    orgId,
    action: `platform.agent_blueprint.${action}`,
    entityType: "agent_blueprint",
    entityId,
    detail,
  });
}

async function registry() {
  const { ensureAgentsRegistered } = await import("../server/agents");
  ensureAgentsRegistered();
  return import("../server/agents/registry");
}

export type StudioToolField = { name: string; type: string; required: boolean };

export type StudioAgent = {
  type: string;
  name: string;
  version: string;
  responsibility: string;
  instructions: string;
  mustNever: string[];
  maxSteps: number;
  tools: { name: string; description: string; fields: StudioToolField[] }[];
};

export type StudioBlueprint = {
  id: string;
  agentType: string;
  name: string;
  description: string;
  responsibility: string;
  instructions: string;
  mustNever: string[];
  tools: string[];
  toolOverrides: Record<string, { name: string; description: string }>;
  maxSteps: number | null;
  status: "draft" | "published" | "archived";
  version: number;
  baseVersion: string;
  outOfDate: boolean;
  workspaceOrgId: string | null;
  updatedAt: string;
  keys: { id: string; label: string; prefix: string; lastUsedAt: string | null }[];
};

export type StudioView = {
  lockedRules: string;
  agents: StudioAgent[];
  blueprints: StudioBlueprint[];
  /** Organisations the super admin owns — where hosted runs may execute. */
  workspaces: { id: string; name: string }[];
};

function fieldsOf(parameters: Record<string, unknown>): StudioToolField[] {
  const props = (parameters["properties"] ?? {}) as Record<string, { type?: unknown }>;
  const required = new Set((parameters["required"] as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: Array.isArray(p?.type) ? p.type.join(" | ") : String(p?.type ?? "object"),
    required: required.has(name),
  }));
}

async function ownedOrgs(userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(
      and(
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, "active"),
        eq(orgMembers.isOwner, true),
      ),
    )
    .orderBy(organizations.name);
}

export const agentStudio = createServerFn({ method: "GET" })
  .middleware([requirePlatformAdmin])
  .handler(async ({ context }): Promise<StudioView> => {
    const { listAgents, getAgent, getTool } = await registry();
    const { isOutOfDate, LOCKED_RULES } = await import("../server/agents/blueprints.server");
    const { toolParameters } = await import("./ai-gateway.server");
    const rows = await db
      .select()
      .from(agentBlueprints)
      .where(inArray(agentBlueprints.status, ["draft", "published"]))
      .orderBy(desc(agentBlueprints.updatedAt));
    const keys = rows.length
      ? await db
          .select()
          .from(agentBlueprintKeys)
          .where(
            and(
              inArray(
                agentBlueprintKeys.blueprintId,
                rows.map((r) => r.id),
              ),
              isNull(agentBlueprintKeys.revokedAt),
            ),
          )
          .orderBy(desc(agentBlueprintKeys.createdAt))
      : [];
    return {
      lockedRules: LOCKED_RULES,
      workspaces: await ownedOrgs(context.userId),
      agents: listAgents()
        .filter((d) => d.tools.length > 0)
        .map((d) => ({
          type: d.type,
          name: d.name,
          version: d.version,
          responsibility: d.responsibility,
          instructions: d.system,
          mustNever: d.mustNever,
          maxSteps: d.maxSteps ?? 20,
          tools: d.tools.map((name) => {
            const t = getTool(name);
            return {
              name,
              description: t?.description ?? "",
              fields: t ? fieldsOf(toolParameters(t.input)) : [],
            };
          }),
        })),
      blueprints: rows.map((r) => {
        const def = getAgent(r.agentType);
        return {
          id: r.id,
          agentType: r.agentType,
          name: r.name,
          description: r.description,
          responsibility: r.responsibility,
          instructions: r.instructions,
          mustNever: r.mustNever,
          tools: r.tools,
          toolOverrides: r.toolOverrides,
          maxSteps: r.maxSteps,
          status: r.status,
          version: r.version,
          baseVersion: r.baseVersion,
          outOfDate: def ? isOutOfDate(def, r) : true,
          workspaceOrgId: r.workspaceOrgId,
          updatedAt: r.updatedAt.toISOString(),
          keys: keys
            .filter((k) => k.blueprintId === r.id)
            .map((k) => ({
              id: k.id,
              label: k.label,
              prefix: k.keyPrefix,
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
  responsibility: z.string().max(600),
  instructions: z.string().max(20_000),
  mustNever: z.array(z.string().max(300)).max(30),
  tools: z.array(z.string().max(80)).max(60),
  toolOverrides: z.record(
    z.string().max(80),
    z.object({ name: z.string().max(80), description: z.string().max(1500) }),
  ),
  maxSteps: z.number().int().nullable(),
  status: z.enum(["draft", "published"]),
});

export type SaveBlueprintInput = z.infer<typeof SaveInput>;

/** Create or update a blueprint. Saving re-bases it on the current stock agent. */
export const saveBlueprint = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { getAgent } = await registry();
    const { manifestHash } = await import("../server/agents/manifest.server");
    const { blueprintProblem, loadBlueprint } = await import("../server/agents/blueprints.server");
    const def = getAgent(data.agentType as AgentType);
    if (!def) throw new Error("Unknown agent.");
    const keep = new Set(data.tools);
    const content = {
      name: data.name.trim(),
      description: data.description.trim(),
      responsibility: data.responsibility.trim(),
      instructions: data.instructions.trim(),
      mustNever: data.mustNever.map((m) => m.trim()).filter(Boolean),
      tools: data.tools,
      toolOverrides: Object.fromEntries(
        Object.entries(data.toolOverrides)
          .filter(([real]) => keep.has(real))
          .map(([real, o]) => [real, { name: o.name.trim(), description: o.description.trim() }]),
      ),
      maxSteps: data.maxSteps,
    };
    const problem = blueprintProblem(def, content);
    if (problem) throw new Error(problem);
    const base = { baseVersion: def.version, baseHash: manifestHash(def) };
    const now = new Date();
    if (data.id) {
      const current = await loadBlueprint(data.id);
      if (!current || current.status === "archived") throw new Error("Blueprint not found.");
      if (current.agentType !== data.agentType) throw new Error("A blueprint keeps its agent.");
      const version = current.version + 1;
      await db
        .update(agentBlueprints)
        .set({ ...content, ...base, status: data.status, version, updatedAt: now })
        .where(eq(agentBlueprints.id, data.id));
      await audit(context.userId, "saved", data.id, {
        agentType: def.type,
        version,
        status: data.status,
        tools: content.tools,
      });
      return { id: data.id };
    }
    const [row] = await db
      .insert(agentBlueprints)
      .values({
        agentType: def.type,
        ...content,
        ...base,
        status: data.status,
        createdBy: context.userId,
      })
      .returning({ id: agentBlueprints.id });
    await audit(context.userId, "created", row!.id, {
      agentType: def.type,
      status: data.status,
    });
    return { id: row!.id };
  });

const IdInput = z.object({ id: z.string().uuid() });

/** A draft copy of a blueprint. */
export const duplicateBlueprint = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { loadBlueprint } = await import("../server/agents/blueprints.server");
    const bp = await loadBlueprint(data.id);
    if (!bp || bp.status === "archived") throw new Error("Blueprint not found.");
    const [row] = await db
      .insert(agentBlueprints)
      .values({
        agentType: bp.agentType,
        baseVersion: bp.baseVersion,
        baseHash: bp.baseHash,
        name: `${bp.name} (copy)`.slice(0, 80),
        description: bp.description,
        responsibility: bp.responsibility,
        instructions: bp.instructions,
        mustNever: bp.mustNever,
        tools: bp.tools,
        toolOverrides: bp.toolOverrides,
        maxSteps: bp.maxSteps,
        status: "draft",
        createdBy: context.userId,
      })
      .returning({ id: agentBlueprints.id });
    await audit(context.userId, "duplicated", row!.id, { from: bp.id });
    return { id: row!.id };
  });

/** Archive a blueprint and revoke its keys. */
export const archiveBlueprint = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }) => {
    const now = new Date();
    const done = await db
      .update(agentBlueprints)
      .set({ status: "archived", updatedAt: now })
      .where(eq(agentBlueprints.id, data.id))
      .returning({ id: agentBlueprints.id });
    if (!done.length) throw new Error("Blueprint not found.");
    await db
      .update(agentBlueprintKeys)
      .set({ revokedAt: now })
      .where(
        and(eq(agentBlueprintKeys.blueprintId, data.id), isNull(agentBlueprintKeys.revokedAt)),
      );
    await audit(context.userId, "archived", data.id, {});
    return { ok: true };
  });

/** The portable package, as a JSON file body. Audited. */
export const downloadBlueprintPackage = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<{ fileName: string; json: string }> => {
    const { getAgent } = await registry();
    const { buildPackage, loadBlueprint } = await import("../server/agents/blueprints.server");
    const bp = await loadBlueprint(data.id);
    if (!bp || bp.status === "archived") throw new Error("Blueprint not found.");
    const def = getAgent(bp.agentType);
    if (!def) throw new Error("Unknown agent.");
    const pkg = buildPackage(def, bp);
    await audit(context.userId, "downloaded", bp.id, { version: bp.version });
    const slug =
      bp.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "agent";
    return { fileName: `${slug}-v${bp.version}.agent.json`, json: JSON.stringify(pkg, null, 2) };
  });

const WorkspaceInput = z.object({ id: z.string().uuid(), orgId: z.string().uuid().nullable() });

/**
 * Where hosted runs execute: an organisation the super admin owns (its data
 * and AI key). Changing it revokes existing keys.
 */
export const setBlueprintWorkspace = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => WorkspaceInput.parse(d))
  .handler(async ({ data, context }) => {
    const { isWorkspaceOwner, loadBlueprint } = await import("../server/agents/blueprints.server");
    const bp = await loadBlueprint(data.id);
    if (!bp || bp.status === "archived") throw new Error("Blueprint not found.");
    if (data.orgId && !(await isWorkspaceOwner(context.userId, data.orgId)))
      throw new Error("Pick an organisation you own.");
    const now = new Date();
    await db
      .update(agentBlueprints)
      .set({ workspaceOrgId: data.orgId, updatedAt: now })
      .where(eq(agentBlueprints.id, bp.id));
    if (bp.workspaceOrgId !== data.orgId)
      await db
        .update(agentBlueprintKeys)
        .set({ revokedAt: now })
        .where(
          and(eq(agentBlueprintKeys.blueprintId, bp.id), isNull(agentBlueprintKeys.revokedAt)),
        );
    await audit(context.userId, "workspace_set", bp.id, { orgId: data.orgId }, data.orgId);
    return { ok: true };
  });

const KeyInput = z.object({ id: z.string().uuid(), label: z.string().max(80) });

/** Issue a hosted-API key (shown once; only its hash is kept). Runs act as the caller. */
export const createBlueprintKey = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => KeyInput.parse(d))
  .handler(async ({ data, context }): Promise<{ key: string }> => {
    const { isWorkspaceOwner, loadBlueprint, newKey } =
      await import("../server/agents/blueprints.server");
    const bp = await loadBlueprint(data.id);
    if (!bp || bp.status !== "published") throw new Error("Publish the blueprint first.");
    if (!bp.workspaceOrgId) throw new Error("Pick a workspace first.");
    if (!(await isWorkspaceOwner(context.userId, bp.workspaceOrgId)))
      throw new Error("You must own the workspace organisation.");
    const k = newKey();
    const [row] = await db
      .insert(agentBlueprintKeys)
      .values({
        blueprintId: bp.id,
        orgId: bp.workspaceOrgId,
        label: data.label.trim(),
        keyPrefix: k.prefix,
        keyHash: k.hash,
        principalUserId: context.userId,
        createdBy: context.userId,
      })
      .returning({ id: agentBlueprintKeys.id });
    await audit(
      context.userId,
      "key_created",
      bp.id,
      { keyId: row!.id, prefix: k.prefix },
      bp.workspaceOrgId,
    );
    return { key: k.key };
  });

const RevokeInput = z.object({ keyId: z.string().uuid() });

export const revokeBlueprintKey = createServerFn({ method: "POST" })
  .middleware([requirePlatformAdmin])
  .validator((d: unknown) => RevokeInput.parse(d))
  .handler(async ({ data, context }) => {
    const done = await db
      .update(agentBlueprintKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentBlueprintKeys.id, data.keyId), isNull(agentBlueprintKeys.revokedAt)))
      .returning({
        blueprintId: agentBlueprintKeys.blueprintId,
        orgId: agentBlueprintKeys.orgId,
        prefix: agentBlueprintKeys.keyPrefix,
      });
    if (!done.length) throw new Error("Key not found.");
    await audit(
      context.userId,
      "key_revoked",
      done[0]!.blueprintId,
      { keyId: data.keyId, prefix: done[0]!.prefix },
      done[0]!.orgId,
    );
    return { ok: true };
  });
