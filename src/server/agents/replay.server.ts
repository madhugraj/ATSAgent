/**
 * Replay comparison (docs/agentic-plan.md §11): a dry-run replay next to the
 * live run it re-executed — which tools each called, in what order, with what
 * outcome, and what it cost. Only step metadata is compared; no tool payloads
 * or model text leave the database.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentRuns, agentSteps } from "@db/schema";

export type SeqItem = { tool: string; status: string };
export type DiffRow = {
  op: "same" | "removed" | "added";
  tool: string;
  was?: string;
  now?: string;
};

/**
 * Align two tool-call sequences by tool name (longest common subsequence).
 * `removed` = only the original called it, `added` = only the replay did.
 */
export function diffToolSequences(original: SeqItem[], replay: SeqItem[]): DiffRow[] {
  const n = original.length;
  const m = replay.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        original[i]!.tool === replay[j]!.tool
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (original[i]!.tool === replay[j]!.tool) {
      out.push({
        op: "same",
        tool: original[i]!.tool,
        was: original[i]!.status,
        now: replay[j]!.status,
      });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "removed", tool: original[i]!.tool, was: original[i]!.status });
      i++;
    } else {
      out.push({ op: "added", tool: replay[j]!.tool, now: replay[j]!.status });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: "removed", tool: original[i]!.tool, was: original[i]!.status });
  for (; j < m; j++) out.push({ op: "added", tool: replay[j]!.tool, now: replay[j]!.status });
  return out;
}

export type RunSide = {
  id: string;
  status: string;
  definitionVersion: string | null;
  definitionHash: string | null;
  steps: number;
  tokens: number;
  durationMs: number | null;
  result: string | null;
  tools: SeqItem[];
};

export type RunComparison = {
  original: RunSide;
  replay: RunSide;
  diff: DiffRow[];
  sameSequence: boolean;
  definitionChanged: boolean;
};

const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

/** Compare a replay with its original. Both runs must belong to `orgId`. */
export async function compareRuns(orgId: string, replayRunId: string): Promise<RunComparison> {
  const [replay] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, replayRunId), eq(agentRuns.orgId, orgId)))
    .limit(1);
  if (!replay) throw new Error("Run not found");
  if (replay.mode !== "replay" || !replay.replayOf) throw new Error("This run is not a replay.");
  const [original] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, replay.replayOf), eq(agentRuns.orgId, orgId)))
    .limit(1);
  if (!original) throw new Error("The original run no longer exists.");

  const steps = await db
    .select({
      runId: agentSteps.runId,
      kind: agentSteps.kind,
      tool: agentSteps.toolName,
      status: agentSteps.status,
    })
    .from(agentSteps)
    .where(and(eq(agentSteps.orgId, orgId), inArray(agentSteps.runId, [original.id, replay.id])))
    .orderBy(asc(agentSteps.seq));
  const toolsOf = (id: string) =>
    steps
      .filter((s) => s.runId === id && s.tool && (s.kind === "tool" || s.kind === "decision"))
      .map((s) => ({ tool: s.tool!, status: s.status }));

  const side = (r: typeof original): RunSide => ({
    id: r.id,
    status: r.status,
    definitionVersion: r.definitionVersion,
    definitionHash: r.definitionHash,
    steps: r.stepCount,
    tokens: r.tokensUsed,
    durationMs: r.finishedAt && r.startedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    result: clip(r.result, 600),
    tools: toolsOf(r.id),
  });
  const o = side(original);
  const p = side(replay);
  const diff = diffToolSequences(o.tools, p.tools);
  return {
    original: o,
    replay: p,
    diff,
    sameSequence: diff.every((d) => d.op === "same"),
    // Unknown when the original predates definition tracking.
    definitionChanged: o.definitionHash !== null && o.definitionHash !== p.definitionHash,
  };
}
