/**
 * OpenTelemetry trace export (docs/agentic-plan.md §9.4 "Portable", Phase 5).
 *
 * Organisations that configure a collector get one trace per finished agent
 * run — a root span for the run and a child span per step — posted as
 * OTLP/HTTP JSON to their endpoint (through safeFetch; header values are
 * encrypted at rest). Spans carry ids, kinds, tool names, statuses, token
 * counts and timings only: no prompts, tool payloads, candidate content, or
 * model / vendor names (§9.4 redaction and vendor-neutral rules).
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "../db";
import { decryptSecret } from "../crypto";
import { log } from "../log";
import { safeFetch } from "../safe-fetch";
import { agentRuns, agentSteps, agentTelemetrySettings } from "@db/schema";

type Run = typeof agentRuns.$inferSelect;
type Step = typeof agentSteps.$inferSelect;

const RUNS_PER_ORG = 25;
/** After a failed export, wait this long before trying the org again. */
const BACKOFF_MINUTES = 10;
/** Runs older than this when export is switched on are not back-filled. */
const BACKFILL_DAYS = 7;

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
type Attr = { key: string; value: AnyValue };

const attr = (key: string, v: string | number | boolean | null | undefined): Attr[] => {
  if (v === null || v === undefined || v === "") return [];
  if (typeof v === "boolean") return [{ key, value: { boolValue: v } }];
  if (typeof v === "number") return [{ key, value: { intValue: String(Math.round(v)) } }];
  return [{ key, value: { stringValue: v } }];
};

const hex = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();
const nanos = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
};

/** The OTLP/JSON body for a batch of runs of one organisation. Pure — unit-tested. */
export function buildOtlpPayload(orgId: string, runs: { run: Run; steps: Step[] }[]) {
  const spans: OtlpSpan[] = [];
  for (const { run, steps } of runs) {
    const traceId = hex(run.traceId);
    const rootId = hex(run.id).slice(0, 16);
    const start = run.startedAt ?? run.createdAt;
    const end = run.finishedAt ?? run.updatedAt;
    spans.push({
      traceId,
      spanId: rootId,
      name: `agent.run ${run.agentType}`,
      kind: 1,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes: [
        ...attr("atsagent.agent.type", run.agentType),
        ...attr("atsagent.run.id", run.id),
        ...attr("atsagent.run.mode", run.mode),
        ...attr("atsagent.run.status", run.status),
        ...attr("atsagent.run.steps", run.stepCount),
        ...attr("atsagent.run.tokens", run.tokensUsed),
        ...attr("atsagent.run.attempts", run.attempts),
        ...attr("atsagent.run.replay_of", run.replayOf),
        ...attr("atsagent.definition.version", run.definitionVersion),
        ...attr("atsagent.definition.hash", run.definitionHash),
        ...attr("atsagent.subject.type", run.subjectType),
        ...attr("atsagent.subject.id", run.subjectId),
        ...attr("atsagent.principal.id", run.principalUserId),
      ],
      status: run.status === "failed" ? { code: 2, message: "run failed" } : { code: 1 },
    });
    for (const s of steps) {
      const stepEnd = s.createdAt;
      const stepStart = new Date(stepEnd.getTime() - Math.max(0, s.durationMs));
      spans.push({
        traceId,
        spanId: hex(s.spanId).slice(0, 16),
        parentSpanId: rootId,
        name:
          s.kind === "model"
            ? "agent.model_turn"
            : s.toolName
              ? `agent.${s.kind} ${s.toolName}`
              : `agent.${s.kind}`,
        kind: s.kind === "model" ? 3 : 1,
        startTimeUnixNano: nanos(stepStart),
        endTimeUnixNano: nanos(stepEnd),
        attributes: [
          ...attr("atsagent.step.seq", s.seq),
          ...attr("atsagent.step.kind", s.kind),
          ...attr("atsagent.step.status", s.status),
          ...attr("atsagent.tool.name", s.toolName),
          ...(s.kind === "model"
            ? [
                ...attr("gen_ai.operation.name", "chat"),
                ...attr("gen_ai.usage.input_tokens", s.promptTokens),
                ...attr("gen_ai.usage.output_tokens", s.completionTokens),
              ]
            : []),
          ...(s.injectionSuspected ? attr("atsagent.injection_suspected", true) : []),
        ],
        status: s.status === "error" ? { code: 2 } : { code: 1 },
      });
    }
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [...attr("service.name", "atsagent"), ...attr("atsagent.org.id", orgId)],
        },
        scopeSpans: [{ scope: { name: "atsagent.agents", version: "1" }, spans }],
      },
    ],
  };
}

export function parseHeaders(enc: string | null): Record<string, string> {
  if (!enc) return {};
  try {
    const parsed = JSON.parse(decryptSecret(enc)) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** POST one OTLP body. Returns null on success, else a short error (no response body). */
export async function postOtlp(
  endpoint: string,
  headersEnc: string | null,
  body: unknown,
): Promise<string | null> {
  try {
    const res = await safeFetch(endpoint, {
      method: "POST",
      timeoutMs: 10_000,
      body: JSON.stringify(body),
      headers: { ...parseHeaders(headersEnc), "content-type": "application/json" },
    });
    return res.ok ? null : `The collector answered HTTP ${res.status}.`;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 200) : "The collector could not be reached.";
  }
}

/** Export finished runs for every org with export switched on. Called by the scheduler tick. */
export async function exportAgentTraces(): Promise<{ orgs: number; runs: number }> {
  const now = new Date();
  const settings = await db
    .select()
    .from(agentTelemetrySettings)
    .where(
      and(
        eq(agentTelemetrySettings.otlpEnabled, true),
        isNotNull(agentTelemetrySettings.otlpEndpoint),
      ),
    );
  let orgs = 0;
  let exported = 0;
  for (const s of settings) {
    if (
      s.lastExportError &&
      s.lastAttemptAt &&
      now.getTime() - s.lastAttemptAt.getTime() < BACKOFF_MINUTES * 60_000
    )
      continue;
    const runs = await db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, s.orgId),
          isNull(agentRuns.otelExportedAt),
          inArray(agentRuns.status, ["done", "failed", "cancelled"]),
          isNotNull(agentRuns.finishedAt),
          gte(agentRuns.finishedAt, new Date(now.getTime() - BACKFILL_DAYS * 864e5)),
        ),
      )
      .orderBy(asc(agentRuns.finishedAt))
      .limit(RUNS_PER_ORG);
    if (!runs.length) continue;
    orgs++;
    const steps = await db
      .select()
      .from(agentSteps)
      .where(
        and(
          eq(agentSteps.orgId, s.orgId),
          inArray(
            agentSteps.runId,
            runs.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(agentSteps.seq));
    const body = buildOtlpPayload(
      s.orgId,
      runs.map((run) => ({ run, steps: steps.filter((x) => x.runId === run.id) })),
    );
    const error = await postOtlp(s.otlpEndpoint!, s.otlpHeadersEnc, body);
    await db
      .update(agentTelemetrySettings)
      .set({
        lastAttemptAt: now,
        lastExportError: error,
        ...(error ? {} : { lastExportAt: now }),
      })
      .where(eq(agentTelemetrySettings.orgId, s.orgId));
    if (error) {
      log.warn("agent.otel.export_failed", { org_id: s.orgId, error });
      continue;
    }
    await db
      .update(agentRuns)
      .set({ otelExportedAt: now })
      .where(
        inArray(
          agentRuns.id,
          runs.map((r) => r.id),
        ),
      );
    exported += runs.length;
  }
  return { orgs, runs: exported };
}
