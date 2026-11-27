/**
 * Candidate identity server functions (plan row 1): the merge review queue
 * and the reversible merge/undo behind it. Every query and write is scoped
 * with eq(table.orgId, context.orgId) — cross-tenant access is impossible by
 * construction. Merges are privileged decisions: the client wraps them in
 * withStepUp, the server audits every one.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../server/db";
import { candidateIdentitySettings, candidateMergeSuggestions, candidates } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import {
  decideSuggestion,
  getIdentitySettings,
  undoMerge,
  type IdentitySettings,
} from "../server/candidates/identity.server";

export type MergeSuggestionView = {
  id: string;
  status: "pending" | "merged" | "kept_separate" | "stale";
  score: number;
  reasons: { signal: string; detail: string }[];
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  a: MergeCandidateView;
  b: MergeCandidateView;
  mergeId: string | null;
};

export type MergeCandidateView = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  location: string | null;
  education: string | null;
  currentEmployer: string | null;
  employmentHistory: { company?: string; employer?: string; start?: string | number }[];
  source: string;
  createdAt: string;
};

const CANDIDATE_VIEW_COLUMNS = {
  id: candidates.id,
  fullName: candidates.fullName,
  email: candidates.email,
  phone: candidates.phone,
  linkedinUrl: candidates.linkedinUrl,
  githubUrl: candidates.githubUrl,
  location: candidates.location,
  education: candidates.education,
  currentEmployer: candidates.currentEmployer,
  employmentHistory: candidates.employmentHistory,
  source: candidates.source,
  createdAt: candidates.createdAt,
} as const;

type CandidateViewRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  location: string | null;
  education: string | null;
  currentEmployer: string | null;
  employmentHistory: unknown;
  source: string;
  createdAt: Date;
};

function toView(row: CandidateViewRow): MergeCandidateView {
  return {
    ...row,
    employmentHistory: Array.isArray(row.employmentHistory)
      ? (row.employmentHistory as MergeCandidateView["employmentHistory"])
      : [],
    createdAt: row.createdAt.toISOString(),
  };
}

/** The review queue: pending pairs first, then the recently decided for context. */
export const listMergeSuggestionsFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(
    async ({
      context,
    }): Promise<{ pending: MergeSuggestionView[]; decided: MergeSuggestionView[] }> => {
      const rows = await db
        .select({
          suggestion: candidateMergeSuggestions,
          a: CANDIDATE_VIEW_COLUMNS,
        })
        .from(candidateMergeSuggestions)
        .innerJoin(
          // a is the existing (matched) record; b joins below by id.
          candidates,
          eq(candidates.id, candidateMergeSuggestions.candidateAId),
        )
        .where(eq(candidateMergeSuggestions.orgId, context.orgId))
        .orderBy(desc(candidateMergeSuggestions.createdAt))
        .limit(100);
      const bIds = [...new Set(rows.map((r) => r.suggestion.candidateBId))];
      const bRows = bIds.length
        ? await db
            .select(CANDIDATE_VIEW_COLUMNS)
            .from(candidates)
            .where(and(eq(candidates.orgId, context.orgId), inArray(candidates.id, bIds)))
        : [];
      const byId = new Map(bRows.map((r) => [r.id, toView(r)]));
      const views: MergeSuggestionView[] = [];
      for (const r of rows) {
        const b = byId.get(r.suggestion.candidateBId);
        if (!b) continue;
        views.push({
          id: r.suggestion.id,
          status: r.suggestion.status,
          score: Number(r.suggestion.score),
          reasons: r.suggestion.reasons,
          createdAt: r.suggestion.createdAt.toISOString(),
          decidedAt: r.suggestion.decidedAt ? r.suggestion.decidedAt.toISOString() : null,
          decisionNote: r.suggestion.decisionNote,
          mergeId: r.suggestion.mergeId,
          a: toView(r.a),
          b,
        });
      }
      return {
        pending: views.filter((v) => v.status === "pending"),
        decided: views.filter((v) => v.status !== "pending").slice(0, 20),
      };
    },
  );

export const decideMergeSuggestionFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({
        suggestionId: z.string().uuid(),
        decision: z.enum(["merge", "keep_separate"]),
        survivorId: z.string().uuid().nullish(),
        note: z.string().max(2000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) =>
    decideSuggestion({
      orgId: context.orgId,
      suggestionId: data.suggestionId,
      decision: data.decision,
      survivorId: data.survivorId ?? null,
      note: data.note ?? null,
      actor: { userId: context.userId, email: context.memberEmail },
    }),
  );

export const undoMergeFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z.object({ mergeId: z.string().uuid(), note: z.string().max(2000).nullish() }).parse(data),
  )
  .handler(async ({ data, context }) =>
    undoMerge({
      orgId: context.orgId,
      mergeId: data.mergeId,
      actor: { userId: context.userId, email: context.memberEmail },
      note: data.note ?? null,
    }),
  );

export const getIdentitySettingsFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<IdentitySettings> => getIdentitySettings(context.orgId));

/** Identity thresholds change destructive behaviour — HR leadership only, audited. */
export const updateIdentitySettingsFn = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((data: unknown) =>
    z
      .object({
        autoMergeStrongKeys: z.boolean().optional(),
        fuzzyHighThreshold: z.number().min(0).max(1).optional(),
        fuzzyLowThreshold: z.number().min(0).max(1).optional(),
        defaultPhoneRegion: z.string().length(2).nullish(),
      })
      .refine((v) => Object.keys(v).some((k) => v[k as keyof typeof v] !== undefined), {
        message: "Nothing to update.",
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertRole(context.userId, context.orgId, ["hr_head", "president_cbo"]);
    const before = await getIdentitySettings(context.orgId);
    if (
      data.fuzzyHighThreshold !== undefined &&
      data.fuzzyLowThreshold !== undefined &&
      data.fuzzyLowThreshold > data.fuzzyHighThreshold
    )
      throw new Error("The low threshold must not exceed the high threshold.");
    const values = {
      orgId: context.orgId,
      autoMergeStrongKeys: data.autoMergeStrongKeys ?? before.autoMergeStrongKeys,
      fuzzyHighThreshold: (data.fuzzyHighThreshold ?? Number(before.fuzzyHighThreshold)).toFixed(2),
      fuzzyLowThreshold: (data.fuzzyLowThreshold ?? Number(before.fuzzyLowThreshold)).toFixed(2),
      defaultPhoneRegion:
        data.defaultPhoneRegion !== undefined ? data.defaultPhoneRegion : before.defaultPhoneRegion,
      updatedBy: context.userId,
      updatedAt: new Date(),
    };
    if (Number(values.fuzzyLowThreshold) > Number(values.fuzzyHighThreshold))
      throw new Error("The low threshold must not exceed the high threshold.");
    const [after] = await db
      .insert(candidateIdentitySettings)
      .values(values)
      .onConflictDoUpdate({
        target: candidateIdentitySettings.orgId,
        set: {
          autoMergeStrongKeys: values.autoMergeStrongKeys,
          fuzzyHighThreshold: values.fuzzyHighThreshold,
          fuzzyLowThreshold: values.fuzzyLowThreshold,
          defaultPhoneRegion: values.defaultPhoneRegion,
          updatedBy: values.updatedBy,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    const { writeAudit } = await import("../server/audit");
    void writeAudit({
      actor: `user:${context.userId}`,
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "candidate.identity_settings_updated",
      entityType: "candidate_identity_settings",
      entityId: context.orgId,
      detail: {
        before: {
          autoMergeStrongKeys: before.autoMergeStrongKeys,
          fuzzyHighThreshold: before.fuzzyHighThreshold,
          fuzzyLowThreshold: before.fuzzyLowThreshold,
          defaultPhoneRegion: before.defaultPhoneRegion,
        },
        after: {
          autoMergeStrongKeys: after?.autoMergeStrongKeys,
          fuzzyHighThreshold: after?.fuzzyHighThreshold,
          fuzzyLowThreshold: after?.fuzzyLowThreshold,
          defaultPhoneRegion: after?.defaultPhoneRegion,
        },
      },
    });
    return { saved: true as const };
  });
