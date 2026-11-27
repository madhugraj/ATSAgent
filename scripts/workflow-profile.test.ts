/**
 * Tenant workflow profile (src/lib/capabilities*.ts, src/lib/workflow-profile.functions.ts,
 * docs/candidate-identification/track-b-design.md §1) against the disposable local database:
 * profile resolution (absent row = full_pipeline), the apply core (capability
 * derivation, refusals, grant bookkeeping, audit rows), tenant settings with the
 * capability-dependency rule and step-up on auto_approved, and the agent-gating rule.
 *
 * Run: bun test scripts/workflow-profile.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentWorkflowGrants,
  agentWorkflowVersions,
  agentWorkflows,
  auditLog,
  orgWorkflowProfiles,
  organizations,
  users,
} = await import("../drizzle/schema");
const caps = await import("../src/lib/capabilities.server");
const allCapabilities = caps.allCapabilities;
const { AGENT_CAPABILITIES } = await import("../src/lib/capabilities");
const { routeCapabilityOf, capabilitiesAdmitRoute } = await import("../src/lib/capabilities");
const { agentGatedOff } = await import("../src/server/agents/registry");
const { STEP_UP_MESSAGE } = await import("../src/server/step-up");
const {
  applyWorkflowProfileCore,
  deriveCapabilities,
  saveWorkflowProfileSettingsCore,
  assertSettingsFitCapabilities,
} = await import("../src/lib/workflow-profile.functions");

let orgId: string;
let userId: string;
const stamp = Date.now();
const actor = { email: `profile-admin-${stamp}@test.local`, userId: "" };

const graphWith = (agentTypes: string[]) => ({
  nodes: agentTypes.map((agentType, i) => ({
    kind: "agent" as const,
    id: `a${i}`,
    data: { agentType },
  })),
  edges: [],
});

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db.insert(users).values({ email: actor.email }).returning({ id: users.id });
  userId = u!.id;
  actor.userId = userId;
  const [o] = await db
    .insert(organizations)
    .values({ name: `Profile Test ${stamp}`, slug: `profile-test-${stamp}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

/** A published workflow whose graph runs the given stock agent types. */
async function publishedWorkflow(agentTypes: string[]) {
  const [w] = await db
    .insert(agentWorkflows)
    .values({
      name: `WF ${stamp}-${agentTypes.join("-")}`,
      graph: graphWith(agentTypes),
      status: "published",
      publishedVersion: 1,
      approvedBy: userId,
      approvedAt: new Date(),
      createdBy: userId,
    })
    .returning({ id: agentWorkflows.id });
  await db.insert(agentWorkflowVersions).values({
    workflowId: w!.id,
    version: 1,
    triggerEvent: "manual",
    graph: graphWith(agentTypes),
    hash: `hash-${stamp}-${agentTypes.length}`,
    test: { ok: true } as never,
    approvedBy: userId,
    approvedAt: new Date(),
    publishedBy: userId,
  });
  const { agentWorkflowGrants } = await import("../drizzle/schema");
  await db.insert(agentWorkflowGrants).values({ workflowId: w!.id, orgId, grantedBy: userId });
  return w!.id;
}

async function auditRows(action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));
}

describe("workflow profile resolution", () => {
  test("absent row means full_pipeline with every capability", async () => {
    caps.resetCapabilitiesCache();
    const p = await caps.profileOf(orgId);
    expect(p.profile).toBe("full_pipeline");
    expect(p.workflowId).toBeNull();
    expect(p.capabilities).toEqual(allCapabilities());
    expect(p.settings).toEqual({});
  });

  test("a template row serves exactly its resolved set; full_pipeline row serves all", async () => {
    caps.resetCapabilitiesCache();
    const wf = await publishedWorkflow(["jd"]);
    const subset = ["pipeline.requisitions", "matching.pool", "matching.shortlist"];
    await db.insert(orgWorkflowProfiles).values({
      orgId,
      profile: "template",
      workflowId: wf,
      resolvedCapabilities: subset,
      settings: { jdDuplicateLookbackDays: 30 },
    });
    caps.invalidateCapabilities(orgId);
    const p = await caps.profileOf(orgId);
    expect(p.profile).toBe("template");
    expect(p.capabilities).toEqual(subset);
    expect(p.settings.jdDuplicateLookbackDays).toBe(30);

    await db
      .update(orgWorkflowProfiles)
      .set({ profile: "full_pipeline", resolvedCapabilities: ["matching.pool"] })
      .where(eq(orgWorkflowProfiles.orgId, orgId));
    caps.invalidateCapabilities(orgId);
    // full_pipeline ignores the stored subset: every capability is back.
    expect((await caps.profileOf(orgId)).capabilities).toEqual(allCapabilities());
    await db.delete(orgWorkflowProfiles).where(eq(orgWorkflowProfiles.orgId, orgId));
    caps.resetCapabilitiesCache();
  });

  test("assertCapability refuses outside the set with the vendor-neutral message", async () => {
    caps.resetCapabilitiesCache();
    await expect(caps.assertCapability(orgId, "recruiting.offers")).resolves.toBeUndefined();
    const wf = await publishedWorkflow(["jd"]);
    await db.insert(orgWorkflowProfiles).values({
      orgId,
      profile: "template",
      workflowId: wf,
      resolvedCapabilities: ["pipeline.requisitions"],
    });
    caps.invalidateCapabilities(orgId);
    await expect(caps.assertCapability(orgId, "recruiting.offers")).rejects.toThrow(
      "not part of your organisation's current workflow",
    );
    await expect(caps.assertCapability(orgId, "pipeline.requisitions")).resolves.toBeUndefined();
    await db.delete(orgWorkflowProfiles).where(eq(orgWorkflowProfiles.orgId, orgId));
    caps.resetCapabilitiesCache();
  });
});

describe("capability derivation from a published workflow graph", () => {
  test("unions the agent→capability map over the graph's agent nodes", async () => {
    const wf = await publishedWorkflow(["jd", "intake", "screening_call"]);
    const derived = await deriveCapabilities(wf);
    expect(derived).toEqual([
      "pipeline.requisitions",
      "recruiting.screening",
      "recruiting.voice",
      "matching.pool",
    ]);
  });

  test("returns [] for an unpublished workflow", async () => {
    const [w] = await db
      .insert(agentWorkflows)
      .values({ name: `Draft WF ${stamp}`, createdBy: userId })
      .returning({ id: agentWorkflows.id });
    expect(await deriveCapabilities(w!.id)).toEqual([]);
  });
});

describe("apply core", () => {
  test("full_pipeline apply resolves every capability, upserts and audits", async () => {
    const r = await applyWorkflowProfileCore({
      orgId,
      profile: "full_pipeline",
      actor,
    });
    expect(r.capabilities).toEqual(allCapabilities());
    const [row] = await db
      .select()
      .from(orgWorkflowProfiles)
      .where(eq(orgWorkflowProfiles.orgId, orgId));
    expect(row!.profile).toBe("full_pipeline");
    expect(row!.resolvedCapabilities).toEqual(allCapabilities());
    const applied = await auditRows("platform.workflow_profile.applied");
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect((applied[0]!.detail as { to?: string }).to).toBe("full_pipeline");
  });

  test("refuses an unpublished workflow and writes nothing", async () => {
    const [w] = await db
      .insert(agentWorkflows)
      .values({ name: `Unpublished WF ${stamp}`, createdBy: userId })
      .returning({ id: agentWorkflows.id });
    await expect(
      applyWorkflowProfileCore({ orgId, profile: "template", workflowId: w!.id, actor }),
    ).rejects.toThrow("Publish the workflow first.");
    const [row] = await db
      .select()
      .from(orgWorkflowProfiles)
      .where(eq(orgWorkflowProfiles.orgId, orgId));
    // The earlier full_pipeline apply is untouched.
    expect(row!.profile).toBe("full_pipeline");
  });

  test("template apply grants the workflow, stores derived capabilities, and audits the grant", async () => {
    const wf = await publishedWorkflow(["jd", "intake"]);
    // Start ungated: the helper pre-grants, but this test exercises the apply's
    // own grant step.
    const { agentWorkflowGrants } = await import("../drizzle/schema");
    await db.delete(agentWorkflowGrants).where(eq(agentWorkflowGrants.workflowId, wf));
    const r = await applyWorkflowProfileCore({ orgId, profile: "template", workflowId: wf, actor });
    // Canonical order: jd → pipeline.requisitions; intake → screening + pool.
    expect(r.capabilities).toEqual([
      "pipeline.requisitions",
      "recruiting.screening",
      "matching.pool",
    ]);
    const [row] = await db
      .select()
      .from(orgWorkflowProfiles)
      .where(eq(orgWorkflowProfiles.orgId, orgId));
    expect(row!.profile).toBe("template");
    expect(row!.workflowId).toBe(wf);
    expect((await auditRows("platform.workflow_profile.grant")).length).toBe(1);
    // Idempotent grant: a second apply adds no second grant row.
    await applyWorkflowProfileCore({ orgId, profile: "template", workflowId: wf, actor });
    expect((await auditRows("platform.workflow_profile.grant")).length).toBe(1);
  });

  test("refuses settings whose capability dependency the profile lacks — before any write", async () => {
    const wf = await publishedWorkflow(["jd", "intake"]);
    await expect(
      applyWorkflowProfileCore({
        orgId,
        profile: "template",
        workflowId: wf,
        settings: { jdRequisitionMode: "approval_gate" },
        actor,
      }),
    ).rejects.toThrow("pipeline.approvals");
    // The stored profile keeps the capabilities of the earlier apply, and the
    // refused setting was never written.
    const [row] = await db
      .select()
      .from(orgWorkflowProfiles)
      .where(eq(orgWorkflowProfiles.orgId, orgId));
    expect(row!.resolvedCapabilities).toEqual([
      "pipeline.requisitions",
      "recruiting.screening",
      "matching.pool",
    ]);
    expect((row!.settings as { jdRequisitionMode?: string }).jdRequisitionMode).toBeUndefined();
  });

  test("switching back to full_pipeline soft-revokes the workflow grant and audits it", async () => {
    const revokesBefore = (await auditRows("platform.workflow_profile.revoke")).length;
    const [grantBefore] = await db
      .select()
      .from(agentWorkflowGrants)
      .where(eq(agentWorkflowGrants.orgId, orgId));
    await applyWorkflowProfileCore({ orgId, profile: "full_pipeline", actor });
    const [grant] = await db
      .select()
      .from(agentWorkflowGrants)
      .where(eq(agentWorkflowGrants.id, grantBefore!.id));
    expect(grant!.revokedAt).not.toBeNull();
    expect(
      (await auditRows("platform.workflow_profile.revoke")).length - revokesBefore,
    ).toBeGreaterThanOrEqual(1);
    expect((await caps.profileOf(orgId)).capabilities).toEqual(allCapabilities());
  });
});

describe("tenant settings core", () => {
  test("audit rows for every apply are present with before/after and actor", async () => {
    // Sanity for the "audit entries checked" gate: the apply audit carries the
    // actor identity we passed.
    const applied = await auditRows("platform.workflow_profile.applied");
    expect(applied[0]!.actor).toBe(actor.email);
    expect(applied[0]!.actorUserId).toBe(userId);
  });

  test("a non-consequential settings change needs no step-up and is audited with before/after", async () => {
    const r = await saveWorkflowProfileSettingsCore({
      orgId,
      settings: { jdDuplicateLookbackDays: 45 },
      actor,
      request: null,
    });
    expect(r.settings.jdDuplicateLookbackDays).toBe(45);
    const rows = await auditRows("workflow_profile.settings_updated");
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(detail.before.jdDuplicateLookbackDays).toBeUndefined();
    expect(detail.after.jdDuplicateLookbackDays).toBe(45);
  });

  test("enabling auto_approved without step-up is refused with STEP_UP_REQUIRED", async () => {
    await expect(
      saveWorkflowProfileSettingsCore({
        orgId,
        settings: { jdRequisitionMode: "auto_approved" },
        actor,
        request: null,
      }),
    ).rejects.toThrow(STEP_UP_MESSAGE);
    const rows = await auditRows("workflow_profile.settings_updated");
    // Still only the first change: the refused one wrote nothing.
    expect(rows.length).toBe(1);
  });

  test("refuses approval_gate when the profile does not resolve pipeline.approvals", async () => {
    const wf = await publishedWorkflow(["jd"]);
    await applyWorkflowProfileCore({ orgId, profile: "template", workflowId: wf, actor });
    caps.invalidateCapabilities(orgId);
    await expect(
      saveWorkflowProfileSettingsCore({
        orgId,
        settings: { jdRequisitionMode: "approval_gate" },
        actor,
        request: null,
      }),
    ).rejects.toThrow("pipeline.approvals");
    // Back to full pipeline for later suites.
    await applyWorkflowProfileCore({ orgId, profile: "full_pipeline", actor });
  });
});

describe("agent gating rule", () => {
  test("agentGatedOff: all caps never gates; empty caps gate non-exempt agents only", () => {
    const all = allCapabilities();
    for (const [type, needed] of Object.entries(AGENT_CAPABILITIES)) {
      expect(agentGatedOff(all, type)).toBe(false);
      if (needed.length > 0) expect(agentGatedOff([], type)).toBe(true);
      else expect(agentGatedOff([], type)).toBe(false);
    }
  });

  test("an agent whose capability set partially survives stays on", () => {
    // intake needs matching.pool + recruiting.screening: one of them suffices.
    expect(agentGatedOff(["matching.pool"], "intake")).toBe(false);
    expect(agentGatedOff(["recruiting.screening"], "intake")).toBe(false);
    expect(agentGatedOff(["recruiting.offers"], "intake")).toBe(true);
  });

  test("assertSettingsFitCapabilities maps the dependency table", () => {
    expect(() =>
      assertSettingsFitCapabilities({ jdRequisitionMode: "approval_gate" }, ["matching.pool"]),
    ).toThrow();
    expect(() =>
      assertSettingsFitCapabilities({ jdRequisitionMode: "approval_gate" }, allCapabilities()),
    ).not.toThrow();
    // auto_approved has no dependency.
    expect(() =>
      assertSettingsFitCapabilities({ jdRequisitionMode: "auto_approved" }, []),
    ).not.toThrow();
  });
});

describe("route classification with search strings and hashes", () => {
  test("a query string or hash never defeats a rule", () => {
    for (const path of [
      "/requisitions?tab=active",
      "/desk?c=abc&split=1",
      "/matching?req=x",
      "/offers?id=1#top",
      "/agents?tab=activity",
    ]) {
      expect(routeCapabilityOf(path)).not.toBeNull();
    }
    expect(routeCapabilityOf("/requisitions?tab=active")?.capability).toBe("pipeline.requisitions");
  });

  test("exemptions still win over rules with search strings", () => {
    expect(routeCapabilityOf("/interviews/mine?tab=upcoming")).toBeNull();
    expect(routeCapabilityOf("/agents/settings?tab=x")).toBeNull();
  });

  test("a zero-capability tenant is admitted nowhere, including /desk by URL", () => {
    expect(capabilitiesAdmitRoute([], routeCapabilityOf("/desk?c=abc")!)).toBe(false);
    expect(capabilitiesAdmitRoute(["matching.pool"], routeCapabilityOf("/desk?c=abc")!)).toBe(true);
  });
});

describe("stale workflow resolution", () => {
  test("a template profile whose workflow lost its live grant resolves to no capabilities", async () => {
    await db.delete(orgWorkflowProfiles).where(eq(orgWorkflowProfiles.orgId, orgId));
    caps.resetCapabilitiesCache();
    const wf = await publishedWorkflow(["jd"]);
    await db.insert(orgWorkflowProfiles).values({
      orgId,
      profile: "template",
      workflowId: wf,
      resolvedCapabilities: ["pipeline.requisitions"],
    });
    caps.resetCapabilitiesCache();
    expect((await caps.profileOf(orgId)).capabilities).toEqual(["pipeline.requisitions"]);

    // Revoke the grant behind the resolver's back (as revokeWorkflow does).
    const { agentWorkflowGrants } = await import("../drizzle/schema");
    await db
      .update(agentWorkflowGrants)
      .set({ revokedAt: new Date() })
      .where(eq(agentWorkflowGrants.workflowId, wf));
    caps.resetCapabilitiesCache();
    const p = await caps.profileOf(orgId);
    expect(p.profile).toBe("template"); // the row itself is untouched
    expect(p.capabilities).toEqual([]); // but the workflow no longer runs

    // Restore by re-applying: grant re-created, capabilities back.
    await applyWorkflowProfileCore({ orgId, profile: "template", workflowId: wf, actor });
    caps.resetCapabilitiesCache();
    expect((await caps.profileOf(orgId)).capabilities).toEqual(["pipeline.requisitions"]);
    await applyWorkflowProfileCore({ orgId, profile: "full_pipeline", actor });
  });
});
