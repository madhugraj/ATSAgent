/**
 * Client-safe agent catalogue: names, descriptions and the plan phase each
 * agent ships in (docs/agentic-plan.md §4). No vendor or model names.
 */
import type { AgentAutonomy, AgentType } from "@db/schema";

export type AgentInfo = {
  type: AgentType;
  label: string;
  description: string;
  /** Plan phase that delivers this agent. */
  phase: 1 | 2 | 3 | 4;
};

export const AGENT_CATALOG: AgentInfo[] = [
  {
    type: "copilot",
    label: "Copilot",
    phase: 1,
    description:
      "Turns a chat request into a plan and hands it to the orchestrator once you confirm.",
  },
  {
    type: "requisition",
    label: "Requisition agent",
    phase: 1,
    description:
      "Drafts requisitions with skills, weights and a pay band backed by market evidence; prepares approval briefs and chases approvers.",
  },
  {
    type: "jd",
    label: "JD agent",
    phase: 1,
    description:
      "Drafts job descriptions from your templates, checks for duplicates and revises on feedback.",
  },
  {
    type: "publishing",
    label: "Publishing agent",
    phase: 1,
    description: "Checks the job card and prepares LinkedIn, job-board and internal postings.",
  },
  {
    type: "intake",
    label: "Intake & matching agent",
    phase: 2,
    description:
      "Parses, dedupes, verifies and scores applicants, shortlists, and proposes rejections for you to confirm.",
  },
  {
    type: "sourcing",
    label: "Sourcing agent",
    phase: 2,
    description:
      "Watches applicants by channel, tops up a starving role from the talent pool, invites strong past candidates to apply (with your approval) and recommends where to publish.",
  },
  {
    type: "screening",
    label: "Screening agent",
    phase: 2,
    description:
      "Builds screening kits, sends assessments, grades answers and writes a proceed / hold summary.",
  },
  {
    type: "followup",
    label: "Follow-up agent",
    phase: 2,
    description:
      "Nudges approvers and interviewers past their deadline and drafts candidate follow-ups.",
  },
  {
    type: "interview",
    label: "Interview coordinator",
    phase: 3,
    description:
      "Proposes panels, finds slots, books meetings, invites candidates and chases scorecards.",
  },
  {
    type: "evaluation",
    label: "Evaluation agent",
    phase: 3,
    description:
      "Writes the interview debrief, flags disagreements, recommends a decision and runs a bias check.",
  },
  {
    type: "offer",
    label: "Offer agent",
    phase: 4,
    description:
      "Proposes pay within the band, drafts the offer and letter, and prepares the approval brief.",
  },
  {
    type: "onboarding",
    label: "Pre-onboarding & release agent",
    phase: 4,
    description: "Requests and cross-checks documents and prepares the offer release for HR.",
  },
];

export const AUTONOMY_OPTIONS: { value: AgentAutonomy; label: string; hint: string }[] = [
  {
    value: "suggest",
    label: "Suggest",
    hint: "Every change and every message waits for your approval.",
  },
  {
    value: "act_and_notify",
    label: "Act and notify",
    hint: "Internal changes run and you are told about each one. Candidate messages send on their own only for the templates ticked below; job-board posts wait for the HR head.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    hint: "Internal changes run silently (still in activity and the audit trail). Every candidate message template sends on its own. Job-board posts go out on their own only on the boards ticked below; otherwise the HR head approves them. Decisions always stay with people.",
  },
];

/**
 * What an organisation may pre-approve for agents. Candidate emails apply from
 * Act and notify (at Autonomous every template is allowed); job boards apply
 * at Autonomous only. The offer release mail is deliberately absent: releasing
 * an offer is always a human decision.
 */
export const WHITELISTABLE_TEMPLATES: { id: string; label: string; group: "email" | "board" }[] = [
  { id: "application_ack", label: "Application acknowledgement", group: "email" },
  { id: "stage_update", label: "Stage update", group: "email" },
  { id: "interview_invite", label: "Interview invitation", group: "email" },
  { id: "assessment_invite", label: "Assessment invitation (and reminder)", group: "email" },
  { id: "document_request", label: "Pre-onboarding document request", group: "email" },
  { id: "role_invite", label: "Invitation to apply (past candidates)", group: "email" },
  { id: "job_board:linkedin", label: "LinkedIn post", group: "board" },
  { id: "job_board:naukri", label: "Naukri posting", group: "board" },
  { id: "job_board:indeed", label: "Indeed posting", group: "board" },
];

export const AGENT_LABEL: Record<string, string> = Object.fromEntries(
  AGENT_CATALOG.map((a) => [a.type, a.label]),
);

export const ROLE_NAME: Record<string, string> = {
  recruiter: "Recruiter",
  hiring_manager: "Hiring manager",
  department_head: "Department head",
  hr_head: "HR head",
  president_cbo: "President / CBO",
};
