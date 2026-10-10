import { currentAgentRun, currentAiSubject } from "./agents/context";
import { db } from "./db";
import { aiUsageEvents, type AiUsageStatus } from "@db/schema";

/**
 * Stable slugs for every AI-powered feature. Each provider request is logged
 * against one of these so the platform console can break spend down per module.
 */
export const AI_FEATURES = [
  "resume_parse",
  "jd_parse",
  "jd_generate",
  "jd_import",
  "weight_suggest",
  "linkedin_post",
  "candidate_score",
  "screening_kit",
  "screening_grade",
  "audio_transcribe",
  "linkedin_signal",
  "writing_signal",
  "claim_verify",
  "assessment_generate",
  "assessment_score",
  "role_profile",
  "doc_extract",
  "market_benchmark",
  "salary_research",
  "template_import",
  "jobcard_qa",
  "offer_letter",
  "copilot",
  "talent_brain",
  "model_test",
  // Agent steps (docs/agentic-plan.md §4) — one slug per agent.
  "agent_copilot",
  "agent_requisition",
  "agent_jd",
  "agent_publishing",
  "agent_intake",
  "agent_screening",
  "agent_interview",
  "agent_evaluation",
  "agent_offer",
  "agent_onboarding",
  "agent_sourcing",
  "agent_followup",
  // Hiring desk conversation turns (docs/agentic-plan.md §13.2).
  "hiring_desk",
  // Talent-pool search: expanding must-haves into equivalent terms.
  "talent_search",
  // Hiring desk: researching skills / experience / pay for a role the person delegated.
  "role_research",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * AI spend ledger. Fire-and-forget like `writeAudit`: a logging failure must
 * never break the AI call it is measuring, but it is logged loudly.
 */
export async function recordAiUsage(input: {
  orgId?: string | null;
  userId?: string | null;
  feature: string;
  provider: string;
  model: string;
  status: AiUsageStatus;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  attempt?: number;
  durationMs?: number | null;
  grounded?: boolean | null;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    const clamp = (n: number | null | undefined) =>
      Math.max(0, Math.round(Number.isFinite(n ?? NaN) ? (n as number) : 0));
    const subject = currentAiSubject();
    const [row] = await db
      .insert(aiUsageEvents)
      .values({
        orgId: input.orgId ?? null,
        userId: input.userId ?? null,
        feature: input.feature,
        provider: input.provider,
        model: input.model,
        status: input.status,
        promptTokens: clamp(input.promptTokens),
        completionTokens: clamp(input.completionTokens),
        totalTokens: clamp(input.totalTokens),
        attempt: Math.max(1, Math.round(input.attempt ?? 1)),
        durationMs:
          input.durationMs == null || !Number.isFinite(input.durationMs)
            ? null
            : Math.max(0, Math.round(input.durationMs)),
        grounded: input.grounded ?? null,
        errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
        // Attribute requests made inside an agent run (incl. AI calls within tools).
        agentRunId: currentAgentRun()?.runId ?? null,
        // …and to the role / candidate it was made for (cost per candidate).
        requisitionId: subject?.requisitionId ?? null,
        applicationId: subject?.applicationId ?? null,
        candidateId: subject?.candidateId ?? null,
      })
      .returning({ id: aiUsageEvents.id });
    if (row && subject?.events) subject.events.push(row.id);
  } catch (e) {
    console.error("[ai-usage] failed to record", input.feature, e);
  }
}
