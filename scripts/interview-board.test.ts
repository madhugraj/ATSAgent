/**
 * The hiring journey's interview board (src/server/desk/interview-board.server.ts):
 * one candidate's rounds, the hand-overs between them and who has them now.
 * Pure — no database.
 *
 * Run: SESSION_SECRET=… DATABASE_URL=postgres://unused@127.0.0.1:1/x bun test scripts/interview-board.test.ts
 */
import { describe, expect, test } from "bun:test";

process.env["DATABASE_URL"] ??= "postgres://unused@127.0.0.1:1/unused";
process.env["SESSION_SECRET"] ??= "interview-board-test-0123456789abcdef";
const { interviewRow } = await import("../src/server/desk/interview-board.server");

const at = (h: number) => new Date(Date.UTC(2026, 10, 24, h));
const base = {
  applicationId: "a",
  name: "Vishal",
  stage: "l3",
  rounds: [
    { level: 1, name: "Skills" },
    { level: 2, name: "Role and ownership" },
    { level: 3, name: "Soft Skills" },
  ],
  interviews: [
    {
      level: 1,
      status: "completed",
      scheduledAt: at(2),
      completedAt: at(3),
      interviewer: "Shalini",
    },
    {
      level: 2,
      status: "completed",
      scheduledAt: at(5),
      completedAt: at(6),
      interviewer: "Sivakami",
    },
    {
      level: 3,
      status: "pending_scheduling",
      scheduledAt: null,
      completedAt: null,
      interviewer: null,
    },
  ],
  scores: [
    { level: 1, evaluator: "Shalini", rating: 4, verdict: "select" },
    { level: 2, evaluator: "Sivakami", rating: 4, verdict: "select" },
  ],
  assessments: [
    { level: 2, rating: 2, verdict: "reject", outcome: "disagree", reviewDecision: "confirmed" },
  ],
  offered: [] as number[],
  tasks: [
    {
      id: "t1",
      agentType: "evaluation",
      title: "Hiring Decision",
      status: "rejected",
      subject: "hiring_decision",
      reason: "I need one more round",
      createdAt: at(7),
    },
    {
      id: "t2",
      agentType: "evaluation",
      title: "One more round?",
      status: "approved",
      subject: "round_addition",
      reason: null,
      createdAt: at(8),
    },
  ],
  activeAgent: null as string | null,
  agentTitle: (t: string) => ({ interview: "Interview coordinator" })[t] ?? t,
  when: (d: Date) => d.toISOString().slice(11, 16),
};

describe("a candidate's interview row", () => {
  test("rounds in order, with the panel agent's dissent, the decision sent back and the round added", () => {
    const row = interviewRow(base);
    expect(row.steps.map((s) => [s.state, s.text])).toEqual([
      ["done", "L1 Skills · Shalini · select 4/5"],
      ["done", "L2 Role and ownership · Sivakami · select 4/5"],
      ["done", "Evaluation · hiring decision sent back"],
      ["done", "Hiring manager added L3"],
      ["current", "L3 Soft Skills · being arranged"],
    ]);
    expect(row.steps[1]!.sub).toBe("L2 panel agent: reject 2/5 → HR head confirmed the panel");
    expect(row.steps[2]!.sub).toBe("“I need one more round”");
    expect(row.now).toEqual({
      text: "Interview coordinator is arranging L3",
      tone: "working",
      taskId: null,
    });
  });

  test("an open request for the candidate is who has them now", () => {
    const row = interviewRow({
      ...base,
      tasks: [
        ...base.tasks,
        {
          id: "t3",
          agentType: "interview",
          title: "Who interviews for L3?",
          status: "open",
          subject: "panel_approval",
          reason: null,
          createdAt: at(9),
        },
      ],
    });
    expect(row.now).toEqual({
      text: "Interview coordinator — Who interviews for L3? · waiting for you",
      tone: "decide",
      taskId: "t3",
    });
  });

  test("times offered, then booked", () => {
    expect(interviewRow({ ...base, offered: [3] }).now.text).toBe(
      "The candidate is picking an L3 time",
    );
    const l3At = (scheduledAt: Date) =>
      interviewRow({
        ...base,
        interviews: [
          ...base.interviews.slice(0, 2),
          { level: 3, status: "scheduled", scheduledAt, completedAt: null, interviewer: "Saranya" },
        ],
      });
    const soon = new Date(Date.now() + 86_400_000);
    const booked = l3At(soon);
    expect(booked.steps.at(-1)!.text).toBe(
      `L3 Soft Skills · booked ${base.when(soon)} with Saranya`,
    );
    expect(booked.now.text).toBe("Waiting for the L3 interview");
    // Booked, but the panellist has not confirmed this time yet: say so, and whom it waits for.
    const unconfirmed = interviewRow({
      ...base,
      interviews: [
        ...base.interviews.slice(0, 2),
        {
          level: 3,
          status: "scheduled",
          scheduledAt: soon,
          completedAt: null,
          interviewer: "Saranya",
        },
      ],
      confirmations: [
        { level: 3, party: "candidate", name: "Vishal", state: "accepted" },
        { level: 3, party: "panelist", name: "Saranya", state: "pending" },
      ],
    });
    expect(unconfirmed.steps.at(-1)!.sub).toBe(
      "Vishal confirmed\nSaranya has not confirmed this time yet",
    );
    expect(unconfirmed.now.text).toBe("Booked — waiting for Saranya to confirm");
    // The time has passed and no scorecard came: say so.
    const late = l3At(new Date(Date.now() - 86_400_000));
    expect(late.now.text).toBe("Waiting for the L3 scorecard");
    expect(late.steps.at(-1)!.sub).toBe("The time has passed and no scorecard is in yet.");
  });

  test("a round skipped for a later one reads 'not held'; a stopped candidate says so", () => {
    const skipped = interviewRow({
      ...base,
      interviews: [
        {
          level: 2,
          status: "scheduled",
          scheduledAt: at(5),
          completedAt: null,
          interviewer: "Madhu",
        },
      ],
      scores: [],
      assessments: [],
      tasks: [],
    });
    expect(skipped.steps.map((s) => s.text)).toEqual([
      "L1 Skills · not held",
      "L2 Role and ownership · booked 05:00 with Madhu",
      "L3 Soft Skills",
    ]);
    const stopped = interviewRow({ ...base, stage: "on_hold", tasks: [] });
    expect(stopped.now).toMatchObject({ tone: "stopped", text: "Stopped (on hold)" });
    expect(stopped.steps.at(-1)!.state).toBe("stopped");
  });
  test("agreeing a time: who on the panel accepted, then where the candidate is", () => {
    const slot = at(7);
    const arranging = (extra: Record<string, unknown>) =>
      interviewRow({
        ...base,
        arranging: [
          {
            level: 3,
            slots: [slot],
            panel: [{ name: "Saranya", state: "accepted", okSlots: [slot] }],
            call: null,
            emailedAt: null,
            chosenAt: null,
            candidate: null,
            ...extra,
          },
        ],
      });
    const waiting = arranging({ call: { status: "approved", endReason: null, since: at(6) } });
    expect(waiting.steps.at(-1)!.text).toBe("L3 Soft Skills · agreeing a time");
    expect(waiting.steps.at(-1)!.sub).toBe(
      "Saranya accepted 07:00\nVishal: AI scheduling call not placed yet (since 06:00)",
    );
    expect(waiting.now.text).toBe("Panel accepted — waiting for Vishal");
    const emailed = arranging({ emailedAt: at(8) });
    expect(emailed.now.text).toBe("Panel accepted — waiting for Vishal to pick a time");
    const picked = arranging({ chosenAt: at(9) });
    expect(picked.now.text).toBe("Time agreed — the interview is being booked");
    const panelPending = arranging({ panel: [{ name: "Saranya", state: "pending", okSlots: [] }] });
    expect(panelPending.now.text).toBe("Waiting for the panel to accept a time");
    // Until the panel has accepted, the candidate is not contacted.
    expect(panelPending.steps.at(-1)!.sub).toBe("Saranya has not answered yet");
  });
});
