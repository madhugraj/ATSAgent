/**
 * Option B of the hiring desk: open decisions live under the journey step
 * their agent works on, and agent reports fold to one line.
 * Run: bun test scripts/desk-journey-decisions.test.ts
 */
import { describe, expect, test } from "bun:test";

import { decisionsByStep, reportLine } from "../src/lib/desk-view";

const STEPS = ["need", "requisition", "jd", "candidates", "screening", "interviews", "decision"];
const task = (id: string, agentType: string, title: string, at: string, extra = {}) => ({
  agentType,
  at,
  card: { type: "task", taskId: id, title, ...extra },
});

describe("decisions on the hiring journey", () => {
  const d = {
    messages: [
      task("t1", "intake", "Reject 11 from first screening", "2026-11-16T09:00:00Z"),
      task(
        "t2",
        "screening",
        "Phone the candidate for an AI screening call",
        "2026-11-19T08:11:00Z",
      ),
      task(
        "t3",
        "screening",
        "Phone the candidate for an AI screening call",
        "2026-11-19T08:11:01Z",
      ),
      task("t4", "panel_l1", "Panel review: L1 interview", "2026-11-19T11:33:00Z", {
        subjectType: "panel_review",
      }),
      task("t5", "sourcing", "Old and done", "2026-11-15T09:00:00Z"),
      task("t6", "mystery_agent", "Something new", "2026-11-19T12:00:00Z"),
      { agentType: "intake", at: "2026-11-19T12:00:00Z", card: { type: "ranked_candidates" } },
    ],
    tasks: { t5: "approved" } as Record<string, string>,
    deciders: { t1: { canDecide: false, waitingFor: "the recruiter" } },
  };
  const by = decisionsByStep(d, STEPS, "interviews");

  test("each open request sits under its agent's step; decided ones are gone", () => {
    expect([...by.keys()].sort()).toEqual(["candidates", "interviews", "screening"]);
    expect(by.get("candidates")!.map((x) => x.title)).toEqual(["Reject 11 from first screening"]);
  });

  test("same-titled requests on a step fold into one row with a count", () => {
    expect(by.get("screening")).toEqual([
      expect.objectContaining({ taskId: "t2", count: 2, urgent: false, waitingFor: null }),
    ]);
  });

  test("a panel review is urgent and listed first; an unknown agent goes to the current step", () => {
    expect(by.get("interviews")!.map((x) => [x.title, x.urgent])).toEqual([
      ["Panel review: L1 interview", true],
      ["Something new", false],
    ]);
  });

  test("someone else's decision says who decides", () => {
    expect(by.get("candidates")![0]!.waitingFor).toBe("the recruiter");
  });
});

describe("agent reports in one line", () => {
  test("first heading or sentence, without markdown", () => {
    expect(reportLine("### Supply Verdict\nThe requisition is **starving**.")).toBe(
      "Supply Verdict",
    );
    expect(reportLine("---\n\n**Debrief:** VISHAL L V — AI Intern")).toBe(
      "Debrief: VISHAL L V — AI Intern",
    );
    expect(reportLine("- one\n- two")).toBe("one");
  });

  test("long lines are clipped", () => {
    const l = reportLine("x".repeat(300));
    expect(l.length).toBe(120);
    expect(l.endsWith("…")).toBe(true);
  });
});
