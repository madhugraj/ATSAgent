/**
 * Training-data capture (docs/agentic-plan.md §14): every model call and every
 * human or real-world judgement on AI work, kept so a future HR model can be
 * trained or fine-tuned on how this work is actually done.
 *
 * - Consent first: nothing is written for an organisation until an owner
 *   switches capture on (training_settings.enabled, default off).
 * - Never in the way: capture failures are logged and swallowed; the call or
 *   decision it records always goes ahead.
 * - Linked: each record carries the agent run, role and candidate it belongs
 *   to (from the same scopes the cost ledger uses), so runs can be rebuilt as
 *   trajectories and joined to their outcomes.
 * - Erasable: rows cascade with their organisation and candidate.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, lte } from "drizzle-orm";

import { db } from "../db";

/**
 * Postgres keeps microseconds; a JS Date keeps milliseconds. A model call and
 * the task it produced often share a millisecond, so "made before" compares
 * against the end of that millisecond — never losing the link.
 */
const endOfMs = (d: Date) => new Date(d.getTime() + 1);
import { log } from "../log";
import {
  applications,
  trainingFeedback,
  trainingInferences,
  trainingSettings,
  type TrainingActorKind,
  type TrainingCallKind,
} from "@db/schema";
import { currentAgentRun, currentAiSubject } from "../agents/context";

/* ------------------------------------------------------------ consent */

const CACHE_MS = 30_000;
const enabledCache = new Map<string, { on: boolean; at: number }>();

/** Whether this organisation agreed to training-data capture (cached briefly). */
export async function captureEnabled(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  const hit = enabledCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.on;
  const [row] = await db
    .select({ enabled: trainingSettings.enabled })
    .from(trainingSettings)
    .where(eq(trainingSettings.orgId, orgId))
    .limit(1);
  const on = row?.enabled ?? false;
  enabledCache.set(orgId, { on, at: Date.now() });
  return on;
}

/** Forget the cached consent (after the setting changes). */
export function resetCaptureCache(orgId?: string): void {
  if (orgId) enabledCache.delete(orgId);
  else enabledCache.clear();
}

/* ------------------------------------------------------------ scope */

/** Ledger rows written while one model call runs (retries included). */
type CallScope = { usageIds: string[]; provider?: string; model?: string };
const callScope = new AsyncLocalStorage<CallScope>();

/** Called by the cost ledger: tie its row to the call being captured. */
export function noteUsageEvent(id: string, provider: string, model: string): void {
  const s = callScope.getStore();
  if (!s) return;
  s.usageIds.push(id);
  s.provider = provider;
  s.model = model;
}

/**
 * The candidate behind an application. Every row naming a candidate's
 * application also names the candidate, so erasing the candidate erases the
 * rows (they cascade on candidate_id).
 */
async function candidateOf(
  applicationId: string | null | undefined,
  candidateId: string | null | undefined,
): Promise<string | null> {
  if (candidateId) return candidateId;
  if (!applicationId) return null;
  const [a] = await db
    .select({ candidateId: applications.candidateId })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  return a?.candidateId ?? null;
}

/* ------------------------------------------------------------ inferences */

/** Binary attachments are described, not copied: the file stays in storage. */
export function describeAttachment(a: { base64: string; contentType: string; fileName?: string }) {
  const bytes = Buffer.from(a.base64, "base64");
  return {
    contentType: a.contentType,
    ...(a.fileName ? { fileName: a.fileName } : {}),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** One JSON value at most this large is kept whole; larger ones are marked. */
const MAX_JSON_CHARS = 2_000_000;
function bounded(v: unknown): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  if (s === undefined) return null;
  return s.length <= MAX_JSON_CHARS
    ? JSON.parse(s)
    : { truncated: true, chars: s.length, head: s.slice(0, MAX_JSON_CHARS) };
}

export type CapturedCall = {
  orgId: string | null | undefined;
  callKind: TrainingCallKind;
  feature: string;
  /** Filled from the ledger when the call itself does not report them. */
  provider?: string | null;
  model?: string | null;
  request: Record<string, unknown>;
  response: unknown;
  status: "ok" | "error";
  errorMessage?: string | null;
  stopReason?: string | null;
  grounded?: boolean | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
};

/**
 * Run one model call and record it: what it was given, what it returned, and
 * the ledger rows it produced. The call's own result is always returned.
 */
export async function withInferenceCapture<R>(
  call: () => Promise<R>,
  describe: (result: R, latencyMs: number) => CapturedCall,
): Promise<R> {
  const scope: CallScope = { usageIds: [] };
  const started = Date.now();
  const result = await callScope.run(scope, call);
  try {
    const c = describe(result, Date.now() - started);
    c.provider ??= scope.provider ?? "unknown";
    c.model ??= scope.model ?? "unknown";
    if (await captureEnabled(c.orgId)) await writeInference(c, scope.usageIds);
  } catch (err) {
    log.warn("training.capture_failed", { kind: "inference", error: err as Error });
  }
  return result;
}

async function writeInference(c: CapturedCall, usageIds: string[]): Promise<string | null> {
  const request = bounded(c.request) as Record<string, unknown>;
  const subject = currentAiSubject();
  const [row] = await db
    .insert(trainingInferences)
    .values({
      orgId: c.orgId!,
      callKind: c.callKind,
      feature: c.feature,
      provider: c.provider ?? "unknown",
      model: c.model ?? "unknown",
      request,
      response: c.status === "ok" ? (bounded(c.response) as never) : null,
      status: c.status,
      errorMessage: c.errorMessage ? c.errorMessage.slice(0, 1000) : null,
      stopReason: c.stopReason ?? null,
      grounded: c.grounded ?? null,
      promptTokens: Math.max(0, Math.round(c.promptTokens ?? 0)),
      completionTokens: Math.max(0, Math.round(c.completionTokens ?? 0)),
      latencyMs: c.latencyMs == null ? null : Math.max(0, Math.round(c.latencyMs)),
      requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      agentRunId: currentAgentRun()?.runId ?? null,
      requisitionId: subject?.requisitionId ?? null,
      applicationId: subject?.applicationId ?? null,
      candidateId: await candidateOf(subject?.applicationId, subject?.candidateId),
      usageEventIds: usageIds,
    })
    .returning({ id: trainingInferences.id });
  return row?.id ?? null;
}

/** The model call in a run that produced what a person is now judging. */
export async function latestInferenceOf(
  runId: string,
  before: Date = new Date(),
): Promise<string | null> {
  const [row] = await db
    .select({ id: trainingInferences.id })
    .from(trainingInferences)
    .where(
      and(
        eq(trainingInferences.agentRunId, runId),
        lte(trainingInferences.createdAt, endOfMs(before)),
      ),
    )
    .orderBy(desc(trainingInferences.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/* ------------------------------------------------------------ feedback */

export type FeedbackInput = {
  orgId: string;
  source: string;
  label: string;
  rating?: number | null;
  reason?: string | null;
  original?: unknown;
  corrected?: unknown;
  inferenceId?: string | null;
  agentRunId?: string | null;
  agentTaskId?: string | null;
  /** When the judged work was proposed: links the run's model call before it. */
  proposedAt?: Date | null;
  requisitionId?: string | null;
  applicationId?: string | null;
  candidateId?: string | null;
  actorUserId?: string | null;
  actorKind?: TrainingActorKind;
};

/** Record a judgement on AI work. Never throws. */
export async function captureFeedback(f: FeedbackInput): Promise<void> {
  try {
    if (!(await captureEnabled(f.orgId))) return;
    const inferenceId =
      f.inferenceId ??
      (f.agentRunId ? await latestInferenceOf(f.agentRunId, f.proposedAt ?? new Date()) : null);
    await db.insert(trainingFeedback).values({
      orgId: f.orgId,
      source: f.source,
      label: f.label,
      rating: f.rating ?? null,
      reason: f.reason ? f.reason.slice(0, 4000) : null,
      original: f.original === undefined ? null : (bounded(f.original) as never),
      corrected: f.corrected === undefined ? null : (bounded(f.corrected) as never),
      inferenceId,
      agentRunId: f.agentRunId ?? null,
      agentTaskId: f.agentTaskId ?? null,
      requisitionId: f.requisitionId ?? null,
      applicationId: f.applicationId ?? null,
      candidateId: await candidateOf(f.applicationId, f.candidateId),
      actorUserId: f.actorUserId ?? null,
      actorKind: f.actorKind ?? "human",
    });
  } catch (err) {
    log.warn("training.capture_failed", {
      kind: "feedback",
      source: f.source,
      error: err as Error,
    });
  }
}

/**
 * The latest model call of a kind made for an application or candidate before
 * a moment — e.g. the document read HR is now verifying, or the match score an
 * interviewer's verdict can be compared with.
 */
export async function latestInferenceFor(q: {
  orgId: string;
  features: string[];
  applicationId?: string | null;
  candidateId?: string | null;
  before?: Date;
}): Promise<string | null> {
  if (!q.applicationId && !q.candidateId) return null;
  const { inArray } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: trainingInferences.id })
    .from(trainingInferences)
    .where(
      and(
        eq(trainingInferences.orgId, q.orgId),
        inArray(trainingInferences.feature, q.features),
        q.applicationId
          ? eq(trainingInferences.applicationId, q.applicationId)
          : eq(trainingInferences.candidateId, q.candidateId!),
        lte(trainingInferences.createdAt, endOfMs(q.before ?? new Date())),
      ),
    )
    .orderBy(desc(trainingInferences.createdAt))
    .limit(1);
  return row?.id ?? null;
}
