/**
 * Shortlist (plan rows 9–10, C2): every server function is capability-gated and
 * org-scoped; decisions need a recruiter-side role and are audited; a
 * shortlist decision adds the person to the role's pipeline as "sourced" only
 * (no stage jump, no message); the Candidate Identification template grants
 * the shortlist capability through its agents.
 *
 * Run: bun test scripts/shortlist.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync("src/lib/shortlist.functions.ts", "utf8");

describe("shortlist server functions", () => {
  test("every function is gated on matching.shortlist after requireOrg", () => {
    const fns = src.match(/createServerFn\(/g)?.length ?? 0;
    expect(fns).toBe(6);
    expect(
      src.match(/\.middleware\(\[requireOrg, requireCapability\("matching\.shortlist"\)\]\)/g)
        ?.length,
    ).toBe(fns);
  });
  test("every query is org-scoped and client requisition ids are checked", () => {
    expect(src.match(/assertRequisitionInOrg\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(src).toContain("eq(profileMatchScores.orgId, context.orgId)");
    expect(src).toContain("eq(candidates.orgId, context.orgId)");
  });
  test("decisions and re-ranks need a recruiter-side role; decisions are audited", () => {
    const decide = src.slice(
      src.indexOf("export const decideShortlistFn"),
      src.indexOf("export const rerankFn"),
    );
    expect(decide).toContain("assertRole(context.userId, context.orgId, RECRUITER_SIDE)");
    expect(decide).toContain("writeAudit(");
    expect(decide).toContain("captureFeedback(");
    const rerank = src.slice(
      src.indexOf("export const rerankFn"),
      src.indexOf("export const shortlistCsvFn"),
    );
    expect(rerank).toContain("assertRole(");
  });
  test("shortlisting adds the person as sourced and never moves an existing application", () => {
    expect(src).toContain('stage: "sourced"');
    expect(src).toContain(".onConflictDoNothing()");
    expect(src).not.toMatch(/update\(applications\)/);
  });
  test("CSV cells are escaped against formula injection", () => {
    expect(src).toContain(`.replace(/^[=+\\-@]/, "'$&")`);
  });
});

describe("Candidate Identification template", () => {
  test("its agents resolve the shortlist and pool capabilities", async () => {
    const { WORKFLOW_TEMPLATES } = await import("../src/lib/workflow-templates");
    const { AGENT_CAPABILITIES } = await import("../src/lib/capabilities");
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === "candidate-identification")!;
    const caps = new Set(
      t.graph.nodes
        .filter((n) => n.kind === "agent")
        .flatMap((n) => AGENT_CAPABILITIES[String(n.data.agentType)] ?? []),
    );
    expect(caps.has("matching.shortlist")).toBe(true);
    expect(caps.has("matching.pool")).toBe(true);
    expect(caps.has("pipeline.requisitions")).toBe(true);
    expect(caps.has("recruiting.interviews")).toBe(false);
    expect(caps.has("recruiting.offers")).toBe(false);
    expect(caps.has("recruiting.voice")).toBe(false);
  });
});

describe("evaluation", () => {
  test("precision and recall at k, and each person's rank", async () => {
    const { evaluateRanking } = await import("../src/lib/shortlist-eval");
    const ranked = Array.from({ length: 30 }, (_, i) => ({
      name: `P ${i + 1}`,
      email: `p${i + 1}@x.test`,
    }));
    const r = evaluateRanking(ranked, ["p1@x.test", "P 7", "p25@x.test", "nobody@x.test"]);
    expect(r.found).toBe(3);
    expect(r.positions.map((p) => p.rank)).toEqual([1, 7, 25, null]);
    expect(r.atK.find((x) => x.k === 5)).toEqual({ k: 5, precision: 0.2, recall: 0.25 });
    expect(r.atK.find((x) => x.k === 10)!.recall).toBe(0.5);
  });
});
