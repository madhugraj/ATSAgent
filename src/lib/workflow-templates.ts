/**
 * Ready-made agent workflows the super admin starts from in the builder
 * (docs/agent-workflows.md). Built only from stock agents and real domain
 * events, with goals and conditions on the fields those events actually carry;
 * each comes with dry-run tests that pass. Starting from one creates a draft
 * to customise — swap in studio agents, change goals, add steps.
 */
import type { WorkflowGraph, WorkflowNode, WorkflowTestScenario } from "@db/schema";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  tests: WorkflowTestScenario[];
};

const at = (x: number, y: number) => ({ x, y });
const n = (
  id: string,
  kind: WorkflowNode["kind"],
  x: number,
  y: number,
  data: WorkflowNode["data"] = {},
): WorkflowNode => ({ id, kind, position: at(x, y), data });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "shortlist-screen-followup",
    name: "Shortlisted → screening, follow up if it stalls",
    description:
      "When candidates are shortlisted, the Screening agent prepares kits and assessments; if it does not finish, the Follow-up agent reminds the team.",
    graph: {
      nodes: [
        n("trigger", "trigger", 260, 0, {
          label: "Candidates shortlisted",
          event: "application.shortlisted",
        }),
        n("screen", "agent", 240, 130, {
          label: "Screen them",
          agentType: "screening",
          goal: "Candidates {{payload.applicationIds}} were shortlisted. Prepare their screening kits, send assessments and summarise who should proceed.",
        }),
        n("finished", "condition", 260, 270, {
          label: "Screening finished?",
          field: "last.status",
          op: "eq",
          value: "done",
        }),
        n("done", "end", 80, 420, { label: "Screened" }),
        n("followup", "agent", 380, 400, {
          label: "Chase it",
          agentType: "followup",
          goal: "Screening of the shortlisted candidates {{payload.applicationIds}} did not finish (it ended {{last.status}}). Find what is overdue for this role and remind the people who need to act.",
        }),
        n("end", "end", 420, 540, { label: "Reminded" }),
      ],
      edges: [
        { id: "e1", source: "trigger", target: "screen" },
        { id: "e2", source: "screen", target: "finished" },
        { id: "e3", source: "finished", target: "done", branch: "yes" },
        { id: "e4", source: "finished", target: "followup", branch: "no" },
        { id: "e5", source: "followup", target: "end" },
      ],
    },
    tests: [
      {
        name: "Screening finishes",
        subjectType: "requisition",
        payload: { applicationIds: ["a1", "a2"] },
        outcomes: { screen: { status: "done", result: "2 proceed, 0 hold" } },
        expectEnd: "done",
      },
      {
        name: "Screening fails → follow-up",
        subjectType: "requisition",
        payload: { applicationIds: ["a1"] },
        outcomes: {
          screen: { status: "failed", result: "" },
          followup: { status: "done", result: "Reminded" },
        },
        expectEnd: "end",
      },
    ],
  },
  {
    id: "approved-role-jd",
    name: "Role approved → draft the JD",
    description:
      "When a requisition moves to approved, the JD agent drafts its job description. Any other status change ends the flow.",
    graph: {
      nodes: [
        n("trigger", "trigger", 260, 0, {
          label: "Requisition status changed",
          event: "requisition.status_changed",
        }),
        n("approved", "condition", 260, 130, {
          label: "Now approved?",
          field: "payload.to",
          op: "eq",
          value: "approved",
        }),
        n("jd", "agent", 80, 270, {
          label: "Draft the JD",
          agentType: "jd",
          goal: "This requisition was just approved (from {{payload.from}}). Draft its job description from the organisation's templates and profile, and submit it for review.",
        }),
        n("drafted", "end", 100, 410, { label: "JD drafted" }),
        n("other", "end", 440, 270, { label: "Not an approval" }),
      ],
      edges: [
        { id: "e1", source: "trigger", target: "approved" },
        { id: "e2", source: "approved", target: "jd", branch: "yes" },
        { id: "e3", source: "approved", target: "other", branch: "no" },
        { id: "e4", source: "jd", target: "drafted" },
      ],
    },
    tests: [
      {
        name: "Approved → JD",
        subjectType: "requisition",
        payload: { from: "pending_hr", to: "approved" },
        outcomes: { jd: { status: "done", result: "JD v1 submitted" } },
        expectEnd: "drafted",
      },
      {
        name: "Sent back → nothing",
        subjectType: "requisition",
        payload: { from: "pending_hr", to: "draft" },
        outcomes: {},
        expectEnd: "other",
      },
    ],
  },
  {
    id: "jd-publish-advertise",
    name: "JD approved → publish → advertise",
    description:
      "When a job description is approved, the Publishing agent posts the role; once it has, the Distribution agent advertises it across the job portals.",
    graph: {
      nodes: [
        n("trigger", "trigger", 260, 0, { label: "JD approved", event: "jd.approved" }),
        n("publish", "agent", 240, 130, {
          label: "Publish",
          agentType: "publishing",
          goal: "The job description for this role was approved. Post the role internally and prepare the LinkedIn and job-board posts.",
        }),
        n("published", "condition", 260, 270, {
          label: "Published?",
          field: "last.status",
          op: "eq",
          value: "done",
        }),
        n("advertise", "agent", 80, 400, {
          label: "Advertise",
          agentType: "distribution",
          goal: "The role is published ({{last.result}}). Advertise it across the job portals and track the CVs they send back.",
        }),
        n("end", "end", 100, 540, { label: "Advertised" }),
        n("stop", "end", 440, 400, { label: "Not published" }),
      ],
      edges: [
        { id: "e1", source: "trigger", target: "publish" },
        { id: "e2", source: "publish", target: "published" },
        { id: "e3", source: "published", target: "advertise", branch: "yes" },
        { id: "e4", source: "published", target: "stop", branch: "no" },
        { id: "e5", source: "advertise", target: "end" },
      ],
    },
    tests: [
      {
        name: "Published → advertised",
        subjectType: "requisition",
        payload: { requisitionId: "r1" },
        outcomes: {
          publish: { status: "done", result: "Posted internally; LinkedIn post sent for approval" },
          advertise: { status: "done", result: "Listed on 3 feeds" },
        },
        expectEnd: "end",
      },
      {
        name: "Publishing fails → stop",
        subjectType: "requisition",
        payload: { requisitionId: "r1" },
        outcomes: { publish: { status: "failed", result: "" } },
        expectEnd: "stop",
      },
    ],
  },
  {
    id: "final-round-evaluation",
    name: "Final-round scorecard → evaluation",
    description:
      "When a scorecard completes the final interview round, the Evaluation agent writes the debrief. Earlier rounds end the flow.",
    graph: {
      nodes: [
        n("trigger", "trigger", 260, 0, {
          label: "Scorecard submitted",
          event: "scorecard.submitted",
        }),
        n("final", "condition", 260, 130, {
          label: "Final round?",
          field: "payload.finalRound",
          op: "eq",
          value: "true",
        }),
        n("evaluate", "agent", 80, 270, {
          label: "Write the debrief",
          agentType: "evaluation",
          goal: "The final interview round (L{{payload.level}}, verdict {{payload.verdict}}) is complete for candidate {{payload.applicationId}}. Write the interview debrief, flag disagreements and recommend a decision for the hiring manager.",
        }),
        n("debriefed", "end", 100, 410, { label: "Debrief written" }),
        n("earlier", "end", 440, 270, { label: "Earlier round" }),
      ],
      edges: [
        { id: "e1", source: "trigger", target: "final" },
        { id: "e2", source: "final", target: "evaluate", branch: "yes" },
        { id: "e3", source: "final", target: "earlier", branch: "no" },
        { id: "e4", source: "evaluate", target: "debriefed" },
      ],
    },
    tests: [
      {
        name: "Final round → debrief",
        subjectType: "requisition",
        payload: { applicationId: "a1", level: 3, verdict: "strong_yes", finalRound: true },
        outcomes: { evaluate: { status: "done", result: "Recommend select" } },
        expectEnd: "debriefed",
      },
      {
        name: "L1 → nothing",
        subjectType: "requisition",
        payload: { applicationId: "a1", level: 1, verdict: "yes", finalRound: false },
        outcomes: {},
        expectEnd: "earlier",
      },
    ],
  },
];
