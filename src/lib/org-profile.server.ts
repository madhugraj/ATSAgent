/**
 * The organisation profile's lifecycle (docs/org-context-agent-plan.md, O0):
 * a draft written by a person, submitted, then approved, declined or sent
 * back by the HR head or the owner. Approved versions never change; the
 * next change is a new draft. Every step is audited and every query is
 * scoped to the actor's organisation.
 *
 * Pay figures and staff names / contacts are refused before anything is
 * saved (src/lib/org-profile.ts), with the reason shown to the person.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../server/db";
import { writeAudit } from "../server/audit";
import {
  agentRuns,
  agentTasks,
  hrmsEmployees,
  orgMembers,
  orgProfileVersions,
  orgProfiles,
  organizations,
  users,
} from "@db/schema";
import { looksLikeInjection } from "../server/agents/injection";
import { assertRole } from "./auth.middleware";
import { checkSections, nameKeys, type OrgProfileSections, type Refusal } from "./org-profile";

export type ProfileActor = { orgId: string; userId: string };
type VersionRow = typeof orgProfileVersions.$inferSelect;

/** Who may write and submit drafts (the owner always passes). */
const EDITORS = ["hr_head", "president_cbo"] as const;

const OPEN = ["draft", "pending", "changes_requested"] as const;
const EDITABLE = new Set(["draft", "changes_requested"]);

async function audit(
  actor: ProfileActor,
  action: string,
  versionId: string | null,
  detail: Record<string, unknown> = {},
) {
  await writeAudit({
    actor: `user:${actor.userId}`,
    actorUserId: actor.userId,
    orgId: actor.orgId,
    action: `org_profile.${action}`,
    entityType: "org_profile_version",
    entityId: versionId,
    detail,
  });
}

async function versionOf(orgId: string, versionId: string): Promise<VersionRow> {
  const [v] = await db
    .select()
    .from(orgProfileVersions)
    .where(and(eq(orgProfileVersions.id, versionId), eq(orgProfileVersions.orgId, orgId)))
    .limit(1);
  if (!v) throw new Error("Profile version not found.");
  return v;
}

/** The organisation's own and legal name: naming the organisation is not naming a person. */
export async function orgNamesOf(orgId: string): Promise<string[]> {
  const [o] = await db
    .select({ name: organizations.name, legalName: organizations.legalName })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return [o?.name, o?.legalName].filter((n): n is string => Boolean(n));
}

/** Full names of the organisation's people (members and HRMS employees), for the refusal. */
export async function staffNameKeys(orgId: string): Promise<string[]> {
  const members = await db
    .select({ name: orgMembers.fullName, userName: users.fullName, email: orgMembers.email })
    .from(orgMembers)
    .leftJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId));
  const employees = await db
    .select({ name: hrmsEmployees.fullName, email: hrmsEmployees.email })
    .from(hrmsEmployees)
    .where(eq(hrmsEmployees.orgId, orgId));
  return nameKeys([
    ...members.flatMap((m) => [
      { name: m.name, email: m.email },
      { name: m.userName, email: m.email },
    ]),
    ...employees,
  ]);
}

export type ProfileState = {
  requireProfile: boolean;
  approved: VersionRow | null;
  open: VersionRow | null;
  history: Pick<
    VersionRow,
    "id" | "version" | "status" | "createdAt" | "submittedAt" | "decidedAt" | "decisionNote"
  >[];
};

export async function profileState(orgId: string): Promise<ProfileState> {
  const [profile] = await db
    .select()
    .from(orgProfiles)
    .where(eq(orgProfiles.orgId, orgId))
    .limit(1);
  const approved = profile?.currentVersionId
    ? await versionOf(orgId, profile.currentVersionId).catch(() => null)
    : null;
  const [open] = await db
    .select()
    .from(orgProfileVersions)
    .where(and(eq(orgProfileVersions.orgId, orgId), inArray(orgProfileVersions.status, [...OPEN])))
    .limit(1);
  const history = await db
    .select({
      id: orgProfileVersions.id,
      version: orgProfileVersions.version,
      status: orgProfileVersions.status,
      createdAt: orgProfileVersions.createdAt,
      submittedAt: orgProfileVersions.submittedAt,
      decidedAt: orgProfileVersions.decidedAt,
      decisionNote: orgProfileVersions.decisionNote,
    })
    .from(orgProfileVersions)
    .where(eq(orgProfileVersions.orgId, orgId))
    .orderBy(desc(orgProfileVersions.version))
    .limit(50);
  return {
    requireProfile: profile?.requireProfile ?? false,
    approved,
    open: open ?? null,
    history,
  };
}

/** The version being worked on, or a new draft copied from the approved one. */
export async function startDraftCore(actor: ProfileActor): Promise<VersionRow> {
  await assertRole(
    actor.userId,
    actor.orgId,
    [...EDITORS],
    "Only the HR head, the CBO or an owner can change the organisation profile.",
  );
  const state = await profileState(actor.orgId);
  if (state.open) return state.open;
  const [{ max }] = (await db
    .select({ max: sql<number>`coalesce(max(${orgProfileVersions.version}), 0)::int` })
    .from(orgProfileVersions)
    .where(eq(orgProfileVersions.orgId, actor.orgId))) as [{ max: number }];
  const [row] = await db
    .insert(orgProfileVersions)
    .values({
      orgId: actor.orgId,
      version: max + 1,
      status: "draft",
      sections: state.approved?.sections ?? {},
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .onConflictDoNothing()
    .returning();
  // Someone else opened a draft at the same moment: use theirs.
  const draft = row ?? (await profileState(actor.orgId)).open;
  if (!draft) throw new Error("Could not start a draft; try again.");
  if (row) await audit(actor, "draft_started", row.id, { version: row.version });
  return draft;
}

export type SaveResult =
  { ok: true; injectionFlagged: boolean } | { ok: false; refused: Refusal[]; problems: string[] };

/**
 * Save the draft's sections. Nothing is saved when an item is refused (pay
 * figure, staff name or contact) — the reasons go back to the person.
 */
export async function saveDraftCore(
  actor: ProfileActor,
  input: { versionId: string; sections: OrgProfileSections },
): Promise<SaveResult> {
  await assertRole(
    actor.userId,
    actor.orgId,
    [...EDITORS],
    "Only the HR head, the CBO or an owner can change the organisation profile.",
  );
  const v = await versionOf(actor.orgId, input.versionId);
  if (!EDITABLE.has(v.status))
    throw new Error(
      v.status === "pending"
        ? "This version is waiting for approval; it can be changed once it is sent back."
        : "Only a draft can be changed — start a new draft.",
    );
  const { sections, refused, problems } = checkSections(
    input.sections,
    await staffNameKeys(actor.orgId),
    await orgNamesOf(actor.orgId),
  );
  if (refused.length || problems.length) {
    await audit(actor, "items_refused", v.id, {
      refused: refused.map((r) => ({ section: r.section, reason: r.reason })),
      problems,
    });
    return { ok: false, refused, problems };
  }
  const injectionFlagged = Object.values(sections)
    .flat()
    .some((i) => looksLikeInjection(i.text));
  const updated = await db
    .update(orgProfileVersions)
    .set({ sections, injectionFlagged, updatedBy: actor.userId, updatedAt: new Date() })
    .where(
      and(
        eq(orgProfileVersions.id, v.id),
        eq(orgProfileVersions.orgId, actor.orgId),
        inArray(orgProfileVersions.status, ["draft", "changes_requested"]),
      ),
    )
    .returning({ id: orgProfileVersions.id });
  if (!updated.length) throw new Error("This version has moved on; refresh to see it.");
  await audit(actor, "edited", v.id, {
    version: v.version,
    items: Object.values(sections).flat().length,
    injection_flagged: injectionFlagged,
  });
  return { ok: true, injectionFlagged };
}

/** Send the draft to the HR head or owner for approval. */
export async function submitDraftCore(
  actor: ProfileActor,
  input: { versionId: string },
): Promise<void> {
  await assertRole(
    actor.userId,
    actor.orgId,
    [...EDITORS],
    "Only the HR head, the CBO or an owner can submit the organisation profile.",
  );
  const v = await versionOf(actor.orgId, input.versionId);
  if (!EDITABLE.has(v.status)) throw new Error("Only a draft can be submitted.");
  if (!(v.sections["about"] ?? []).length)
    throw new Error("Add at least one line under About before submitting.");
  const now = new Date();
  const updated = await db
    .update(orgProfileVersions)
    .set({ status: "pending", submittedBy: actor.userId, submittedAt: now, updatedAt: now })
    .where(
      and(
        eq(orgProfileVersions.id, v.id),
        eq(orgProfileVersions.orgId, actor.orgId),
        inArray(orgProfileVersions.status, ["draft", "changes_requested"]),
      ),
    )
    .returning({ id: orgProfileVersions.id });
  if (!updated.length) throw new Error("This version has moved on; refresh to see it.");
  await audit(actor, "submitted", v.id, { version: v.version });
}

/** Throw away a draft nobody has submitted (or one sent back). */
export async function discardDraftCore(
  actor: ProfileActor,
  input: { versionId: string },
): Promise<void> {
  await assertRole(
    actor.userId,
    actor.orgId,
    [...EDITORS],
    "Only the HR head, the CBO or an owner can change the organisation profile.",
  );
  const v = await versionOf(actor.orgId, input.versionId);
  if (!EDITABLE.has(v.status)) throw new Error("Only a draft can be discarded.");
  await db
    .delete(orgProfileVersions)
    .where(
      and(
        eq(orgProfileVersions.id, v.id),
        eq(orgProfileVersions.orgId, actor.orgId),
        inArray(orgProfileVersions.status, ["draft", "changes_requested"]),
      ),
    );
  await audit(actor, "draft_discarded", v.id, { version: v.version });
}

export type ProfileDecision =
  | { decision: "approve"; note?: string | null }
  | { decision: "decline" | "send_back"; note: string };

/**
 * The human decision on a submitted version — the HR head or the owner
 * (the owner passes assertRole for hr_head). Never taken by an agent: the
 * agent asks with request_approval and this runs as the person deciding.
 */
export async function decideVersionCore(
  actor: ProfileActor,
  input: { versionId: string } & ProfileDecision,
): Promise<void> {
  await assertRole(
    actor.userId,
    actor.orgId,
    "hr_head",
    "Only the HR head or an owner can approve the organisation profile.",
  );
  const v = await versionOf(actor.orgId, input.versionId);
  if (v.status !== "pending")
    throw new Error(`This version is ${v.status.replace("_", " ")}, not waiting for approval.`);
  const note = input.note?.trim() || null;
  if (input.decision !== "approve" && (!note || note.length < 3))
    throw new Error(
      input.decision === "send_back"
        ? "Say what should change (at least a few words)."
        : "Say why you are declining (at least a few words).",
    );
  const now = new Date();
  const status =
    input.decision === "approve"
      ? "approved"
      : input.decision === "send_back"
        ? "changes_requested"
        : "declined";
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(orgProfileVersions)
      .set({ status, decidedBy: actor.userId, decidedAt: now, decisionNote: note, updatedAt: now })
      .where(
        and(
          eq(orgProfileVersions.id, v.id),
          eq(orgProfileVersions.orgId, actor.orgId),
          eq(orgProfileVersions.status, "pending"),
        ),
      )
      .returning({ id: orgProfileVersions.id });
    if (!moved.length) throw new Error("This version has already been decided.");
    if (status !== "approved") return;
    await tx
      .update(orgProfileVersions)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(orgProfileVersions.orgId, actor.orgId),
          eq(orgProfileVersions.status, "approved"),
          sql`${orgProfileVersions.id} <> ${v.id}`,
        ),
      );
    await tx
      .insert(orgProfiles)
      .values({
        orgId: actor.orgId,
        currentVersionId: v.id,
        updatedBy: actor.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: orgProfiles.orgId,
        set: { currentVersionId: v.id, updatedBy: actor.userId, updatedAt: now },
      });
  });
  await audit(
    actor,
    input.decision === "approve"
      ? "approved"
      : input.decision === "send_back"
        ? "sent_back"
        : "declined",
    v.id,
    { version: v.version, note },
  );
  await closeGateTasks(actor.orgId, v.id, actor.userId, status);
}

/**
 * Close agent approval requests for this version decided here, outside the
 * inbox, so the waiting run carries on (as syncGateTasks does for
 * requisitions). When the decision came from the inbox card, resolveTask
 * takes the task over with the person's own words.
 */
async function closeGateTasks(
  orgId: string,
  versionId: string,
  decidedBy: string,
  outcome: string,
) {
  const open = await db
    .select({ id: agentTasks.id, runId: agentTasks.runId })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.orgId, orgId),
        eq(agentTasks.status, "open"),
        eq(agentTasks.kind, "gate"),
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'type' = 'org_profile'`,
        sql`${agentTasks.proposedAction} -> 'args' -> 'subject' ->> 'versionId' = ${versionId}`,
      ),
    );
  for (const t of open) {
    const approved = outcome === "approved";
    const at = new Date();
    await db
      .update(agentTasks)
      .set({
        status: approved ? "approved" : "rejected",
        response: (approved
          ? { status: "approved", comment: `Decided outside the inbox (now ${outcome}).` }
          : {
              status: "rejected",
              reason: `Decided outside the inbox (now ${outcome}).`,
              ...(outcome === "changes_requested" ? { changes: true } : {}),
            }) as never,
        decidedBy,
        decidedAt: at,
        updatedAt: at,
      })
      .where(and(eq(agentTasks.id, t.id), eq(agentTasks.status, "open")));
    const [stillOpen] = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(and(eq(agentTasks.runId, t.runId), eq(agentTasks.status, "open")))
      .limit(1);
    if (!stillOpen)
      await db
        .update(agentRuns)
        .set({ status: "queued", updatedAt: at })
        .where(and(eq(agentRuns.id, t.runId), eq(agentRuns.status, "awaiting_human")));
  }
}

/** The organisation's hard gate: no requisition until a profile is approved. */
export async function setRequireProfileCore(
  actor: ProfileActor,
  input: { required: boolean },
): Promise<void> {
  await assertRole(
    actor.userId,
    actor.orgId,
    "hr_head",
    "Only the HR head or an owner can change this setting.",
  );
  const now = new Date();
  await db
    .insert(orgProfiles)
    .values({
      orgId: actor.orgId,
      requireProfile: input.required,
      updatedBy: actor.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orgProfiles.orgId,
      set: { requireProfile: input.required, updatedBy: actor.userId, updatedAt: now },
    });
  await audit(actor, "require_changed", null, { required: input.required });
}

/** Whether the organisation has an approved profile, and whether it insists on one. */
export async function profileGate(
  orgId: string,
): Promise<{ approved: boolean; required: boolean }> {
  const [p] = await db
    .select({ current: orgProfiles.currentVersionId, required: orgProfiles.requireProfile })
    .from(orgProfiles)
    .where(eq(orgProfiles.orgId, orgId))
    .limit(1);
  return { approved: Boolean(p?.current), required: p?.required ?? false };
}

export const PROFILE_REQUIRED_MESSAGE =
  "Your organisation requires an approved organisation profile before a role is raised. Ask the HR head or an owner to approve it in Organisation → Profile.";

/** Refuse to raise a requisition while the organisation insists on an approved profile it lacks. */
export async function assertProfileAllowsRequisition(orgId: string): Promise<void> {
  const gate = await profileGate(orgId);
  if (gate.required && !gate.approved) throw new Error(PROFILE_REQUIRED_MESSAGE);
}

/** For the approval card (gateFor): a pending version, by id, in this organisation. */
export async function pendingVersion(orgId: string, versionId: string) {
  const v = await versionOf(orgId, versionId).catch(() => null);
  const state = v ? await profileState(orgId) : null;
  return v ? { version: v, approved: state?.approved ?? null } : null;
}
