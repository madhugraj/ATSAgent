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
    hint: "Internal changes run and you are told; messages outside the organisation still wait for approval unless the template is pre-approved.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    hint: "Internal changes run; pre-approved templates send on their own; everything else waits for approval.",
  },
];

/**
 * Candidate emails an organisation may pre-approve for agents. The offer
 * release mail is deliberately absent: releasing an offer is always a human
 * decision.
 */
export const WHITELISTABLE_TEMPLATES: { id: string; label: string }[] = [
  { id: "application_ack", label: "Application acknowledgement" },
  { id: "stage_update", label: "Stage update" },
  { id: "interview_invite", label: "Interview invitation" },
  { id: "assessment_invite", label: "Assessment invitation (and reminder)" },
  { id: "document_request", label: "Pre-onboarding document request" },
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
