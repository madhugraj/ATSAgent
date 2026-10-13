/**
 * Preliminary screening support.
 *
 * Two agents, both routed through the organisation's configured provider/model
 * (`aiJson`), so a bring-your-own key is honoured end to end:
 *
 *  1. `buildScreeningKit` — reads the JD and the CV side by side and writes the
 *     questions HR should ask on the first call, each with the reason it matters
 *     for THIS pairing and the answer a strong candidate would give.
 *  2. `gradeScreening` — takes what the candidate actually said (typed, or an
 *     audio recording transcribed first) and returns a per-question verdict, a
 *     screening score and a recommendation with its rationale.
 */

import {
  aiJson,
  INJECTION_RULES,
  untrusted,
  resolveAiConfig,
  type AiUsage,
} from "./ai-gateway.server";

export const FOCUS_AREAS = [
  "must_have_skill",
  "experience_depth",
  "ownership",
  "stability",
  "logistics",
  "culture_mindset",
] as const;

export type ScreeningFocus = (typeof FOCUS_AREAS)[number];

export type ScreeningQuestion = {
  id: string;
  focus: ScreeningFocus;
  question: string;
  /** Why this question is being asked of this candidate for this JD. */
  reason: string;
  /** What a convincing answer contains. */
  expected_answer: string;
  /** What a weak or evasive answer sounds like. */
  weak_answer: string;
  /** Relative importance 1-5, used to weight the second-level score. */
  weight: number;
};

export type ScreeningKit = {
  questions: ScreeningQuestion[];
  focus_summary: string;
  /** Server-internal: persisted for the audit trail, never sent to a client. */
  engine: { provider: string; model: string };
};

export type ScreeningVerdict = {
  question_id: string;
  question: string;
  verdict: "strong" | "partial" | "weak" | "not_answered";
  score: number;
  evidence: string;
  rationale: string;
};

export type ScreeningGrade = {
  screening_score: number;
  verdicts: ScreeningVerdict[];
  rationale: string;
  red_flags: string[];
  recommendation: "advance" | "hold" | "reject";
  recommendation_reason: string;
  /** Server-internal: persisted for the audit trail, never sent to a client. */
  engine: { provider: string; model: string };
};

const FOCUS_LABEL: Record<ScreeningFocus, string> = {
  must_have_skill: "Must-have skill",
  experience_depth: "Experience depth",
  ownership: "Ownership & impact",
  stability: "Stability & tenure",
  logistics: "Logistics & offer fit",
  culture_mindset: "Mindset & culture",
};

export function focusLabel(focus: string) {
  return FOCUS_LABEL[focus as ScreeningFocus] ?? "General";
}

const clampScore = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const text = (v: unknown, max = 600) => String(v ?? "").slice(0, max);

/* ------------------------------------------------------------------ kit */

export async function buildScreeningKit(input: {
  /** Owning organisation — its own AI key pays for this call. */
  orgId: string;
  role: string;
  jdText: string;
  mustHave: string[];
  goodToHave: string[];
  experienceMin: number;
  experienceMax: number;
  budgetCtc: number | null;
  currency: string;
  candidateName: string;
  resumeText: string | null;
  candidateSkills: string[];
  experienceYears: number;
  currentEmployer: string | null;
  employmentHistory: unknown;
  education: string | null;
  currentCtc: number | null;
  expectedCtc: number | null;
  noticePeriodDays: number | null;
  location: string | null;
  matchRationale: string | null;
  missingSkills: string[];
  riskFlags: string[];
  /** The completed written assessment (mindset and ways of working), when there is one. */
  writtenAssessment?: {
    score: number | null;
    summary: string | null;
    areas: { area: string; score: number | null }[];
    strengths: string[];
    redFlags: string[];
  } | null;
}): Promise<ScreeningKit> {
  const result = await aiJson<{ questions: ScreeningQuestion[]; focus_summary: string }>({
    system:
      INJECTION_RULES +
      "\nYou prepare a recruiter's first screening call. Compare the job description with this specific CV and write " +
      "8 to 10 questions that resolve what the paper alone cannot: unevidenced must-have skills, shallow or " +
      "inflated experience, employment gaps and short tenures, ownership versus participation, salary/notice/" +
      "location fit, and mindset for this team. Never ask something the CV already answers plainly, and never ask " +
      "about age, marital status, religion, caste, gender, health or family. " +
      "For every question give: focus (one of must_have_skill, experience_depth, ownership, stability, logistics, " +
      "culture_mindset), question (asked in plain conversational English, one thing at a time), reason (why THIS " +
      "candidate is being asked it — cite the JD requirement or the CV line that triggers it), expected_answer " +
      "(the specifics a strong candidate would give), weak_answer (what an evasive or thin answer sounds like) and " +
      "weight (1-5, higher for must-haves). " +
      "existing_match.risk_flags are automated inferences from the CV: verify them, never treat them as facts. " +
      "If written_assessment is present, the candidate has already been assessed in writing on mindset and ways of " +
      "working: do not ask again what it established; probe its weakest areas and any red flags, and resolve the CV " +
      "inferences it did not settle. Say in reason when a question follows from the written assessment. " +
      "Return ONLY JSON: {questions:[{focus, question, reason, expected_answer, weak_answer, weight}], " +
      "focus_summary: one or two sentences on what this call must establish}.",
    prompt: untrusted(
      "role_and_candidate",
      JSON.stringify({
        role: input.role,
        jd: input.jdText.slice(0, 6000),
        must_have_skills: input.mustHave.slice(0, 25),
        good_to_have_skills: input.goodToHave.slice(0, 25),
        experience_range: [input.experienceMin, input.experienceMax],
        budget_ctc: input.budgetCtc,
        currency: input.currency,
        candidate: {
          name: input.candidateName,
          experience_years: input.experienceYears,
          skills: input.candidateSkills.slice(0, 40),
          current_employer: input.currentEmployer,
          employment_history: input.employmentHistory,
          education: input.education,
          current_ctc: input.currentCtc,
          expected_ctc: input.expectedCtc,
          notice_period_days: input.noticePeriodDays,
          location: input.location,
          resume: (input.resumeText ?? "").slice(0, 8000),
        },
        existing_match: {
          rationale: input.matchRationale,
          missing_skills: input.missingSkills.slice(0, 20),
          risk_flags: input.riskFlags.slice(0, 20),
        },
        ...(input.writtenAssessment
          ? {
              written_assessment: {
                score: input.writtenAssessment.score,
                summary: (input.writtenAssessment.summary ?? "").slice(0, 1500),
                areas: input.writtenAssessment.areas.slice(0, 12),
                strengths: input.writtenAssessment.strengths.slice(0, 10),
                red_flags: input.writtenAssessment.redFlags.slice(0, 10),
              },
            }
          : {}),
      }),
    ),
    orgId: input.orgId,
    feature: "screening_kit",
  });
  if (!result.ok) throw new Error(result.message);

  const raw = Array.isArray(result.data.questions) ? result.data.questions : [];
  const questions: ScreeningQuestion[] = raw.slice(0, 12).map((q, i) => ({
    id: `q${i + 1}`,
    focus: (FOCUS_AREAS as readonly string[]).includes(String(q.focus))
      ? (q.focus as ScreeningFocus)
      : "experience_depth",
    question: text(q.question, 400),
    reason: text(q.reason, 500),
    expected_answer: text(q.expected_answer, 700),
    weak_answer: text(q.weak_answer, 500),
    weight: Math.max(1, Math.min(5, Math.round(Number(q.weight) || 3))),
  }));
  if (!questions.length) throw new Error("The model returned no questions — try again.");

  return {
    questions,
    focus_summary: text(result.data.focus_summary, 600),
    engine: { provider: result.provider, model: result.model },
  };
}

/* ---------------------------------------------------------------- grade */

export async function gradeScreening(input: {
  /** Owning organisation — its own AI key pays for this call. */
  orgId: string;
  role: string;
  jdText: string;
  mustHave: string[];
  candidateName: string;
  questions: ScreeningQuestion[];
  /** Per-question answers HR typed in, keyed by question id. */
  answers: { question_id: string; answer: string }[];
  /** Whole-call notes or an audio transcript, used when answers are unsplit. */
  transcript: string | null;
}): Promise<ScreeningGrade> {
  const result = await aiJson<{
    screening_score: number;
    verdicts: ScreeningVerdict[];
    rationale: string;
    red_flags: string[];
    recommendation: string;
    recommendation_reason: string;
  }>({
    system:
      INJECTION_RULES +
      "\nYou grade a recruiter's screening call. For each prepared question, judge the candidate's actual answer " +
      "against the expected answer: verdict is 'strong', 'partial', 'weak' or 'not_answered' (use not_answered " +
      "only when the answer or transcript contains nothing on it — never guess). Give a 0-100 score per question, " +
      "quote the exact line of the answer you relied on in `evidence` (empty string when nothing was said), and " +
      "one sentence of rationale. Weight the overall screening_score by each question's weight, penalising " +
      "unanswered must-haves. When a transcript is supplied instead of per-question answers, find the part of the " +
      "transcript that addresses each question. List concrete red_flags (contradiction with the CV, inflated " +
      "claim, no specifics, notice/salary blocker). recommendation is 'advance', 'hold' or 'reject' with a reason " +
      "a hiring manager can act on. Judge only what was said; never invent answers. " +
      "Return ONLY JSON: {screening_score, verdicts:[{question_id, verdict, score, evidence, rationale}], " +
      "rationale, red_flags:[string], recommendation, recommendation_reason}.",
    prompt: untrusted(
      "screening_transcript",
      JSON.stringify({
        role: input.role,
        jd: input.jdText.slice(0, 4000),
        must_have_skills: input.mustHave.slice(0, 25),
        candidate: input.candidateName,
        questions: input.questions.map((q) => ({
          question_id: q.id,
          question: q.question,
          expected_answer: q.expected_answer,
          weak_answer: q.weak_answer,
          weight: q.weight,
          focus: q.focus,
        })),
        answers: input.answers.filter((a) => a.answer.trim().length > 0),
        transcript: (input.transcript ?? "").slice(0, 20000),
      }),
    ),
    orgId: input.orgId,
    feature: "screening_grade",
  });
  if (!result.ok) throw new Error(result.message);

  const byId = new Map(input.questions.map((q) => [q.id, q]));
  const verdicts: ScreeningVerdict[] = (
    Array.isArray(result.data.verdicts) ? result.data.verdicts : []
  ).map((v) => {
    const q = byId.get(String(v.question_id));
    return {
      question_id: String(v.question_id ?? ""),
      question: q?.question ?? "",
      verdict: (["strong", "partial", "weak", "not_answered"] as const).includes(v.verdict)
        ? v.verdict
        : "not_answered",
      score: clampScore(v.score),
      evidence: text(v.evidence, 500),
      rationale: text(v.rationale, 400),
    };
  });

  // Recompute the headline from the per-question verdicts so the number always
  // matches the detail HR can see.
  const weighted = verdicts.reduce(
    (acc, v) => {
      const w = byId.get(v.question_id)?.weight ?? 3;
      return { sum: acc.sum + v.score * w, weight: acc.weight + w };
    },
    { sum: 0, weight: 0 },
  );
  const screening_score = weighted.weight
    ? Math.round(weighted.sum / weighted.weight)
    : clampScore(result.data.screening_score);

  const rec = String(result.data.recommendation ?? "").toLowerCase();
  return {
    screening_score,
    verdicts,
    rationale: text(result.data.rationale, 1500),
    red_flags: (Array.isArray(result.data.red_flags) ? result.data.red_flags : [])
      .map((f) => text(f, 200))
      .filter(Boolean)
      .slice(0, 8),
    recommendation: rec === "advance" || rec === "reject" ? rec : "hold",
    recommendation_reason: text(result.data.recommendation_reason, 600),
    engine: { provider: result.provider, model: result.model },
  };
}

/* ----------------------------------------------------------- transcribe */

const OPENAI_TRANSCRIBE = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Transcribe a screening recording with the organisation's own provider when it
 * can hear audio, so a bring-your-own key is used for this step too. Anthropic
 * has no transcription endpoint — that is reported, not silently re-routed.
 */
export async function transcribeScreeningAudio(input: {
  orgId?: string | null;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}): Promise<{ transcript: string; engine: string }> {
  const cfg = await resolveAiConfig(input.orgId);
  if (cfg.provider === "anthropic") {
    throw new Error(
      "The configured AI model cannot transcribe audio. Type the answers in, or switch the AI provider on Integrations.",
    );
  }
  if (!cfg.apiKey) {
    // Vendor-neutral on purpose — provider names never leave the server
    // outside the Integrations → AI model settings page.
    throw new Error("No AI model key saved. Add one on the Integrations page.");
  }

  // Google's own API has no OpenAI-style transcription route, so a BYO Gemini
  // key transcribes through its chat endpoint with inline audio instead.
  const gemini = cfg.provider === "google";
  const endpoint = OPENAI_TRANSCRIBE;
  const model = gemini ? "gemini-2.5-flash" : "gpt-4o-mini-transcribe";
  const startedAt = Date.now();
  const { recordAiUsage } = await import("../server/ai-usage");
  const log = (status: "ok" | "error", usage: AiUsage | null, message?: string) =>
    recordAiUsage({
      orgId: input.orgId ?? null,
      feature: "audio_transcribe",
      provider: cfg.provider,
      model,
      status,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      durationMs: Date.now() - startedAt,
      errorMessage: message ?? null,
    }).catch(() => undefined);

  if (gemini) {
    const base64 = Buffer.from(input.bytes).toString("base64");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: "Transcribe this screening call verbatim. Label each speaker as Recruiter: or Candidate: when you can tell them apart. Return the transcript only.",
                },
                { inlineData: { mimeType: input.contentType, data: base64 } },
              ],
            },
          ],
        }),
      },
    );
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      await log("error", null, `Gemini transcription failed (${res.status}): ${raw.slice(0, 300)}`);
      throw new Error(`Gemini transcription failed (${res.status}): ${raw.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number };
    };
    const usage: AiUsage | null = json.usageMetadata
      ? {
          promptTokens: json.usageMetadata.promptTokenCount ?? 0,
          completionTokens: 0,
          totalTokens:
            json.usageMetadata.totalTokenCount ?? json.usageMetadata.promptTokenCount ?? 0,
        }
      : null;
    if (usage) usage.completionTokens = Math.max(0, usage.totalTokens - usage.promptTokens);
    const transcript = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!transcript) {
      await log("error", usage, "The recording produced no transcript.");
      throw new Error("The recording produced no transcript.");
    }
    await log("ok", usage);
    return { transcript, engine: `gemini · ${model}` };
  }

  const form = new FormData();
  form.append("model", model);
  form.append(
    "file",
    new Blob([Uint8Array.from(input.bytes)], { type: input.contentType }),
    input.filename,
  );
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 400) || `Transcription failed (${res.status}).`;
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message ?? parsed?.message ?? message;
    } catch {
      /* plain text */
    }
    if (res.status === 402)
      message = `${message} — check this organisation's provider billing and API-key quota.`;
    await log("error", null, `${cfg.provider}: ${message}`);
    throw new Error(message);
  }
  const json = (await res.json()) as {
    text?: string;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  const usage: AiUsage | null = json.usage
    ? {
        promptTokens: json.usage.input_tokens ?? 0,
        completionTokens: json.usage.output_tokens ?? 0,
        totalTokens:
          json.usage.total_tokens ??
          (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
      }
    : null;
  const transcript = (json.text ?? "").trim();
  if (!transcript) {
    await log("error", usage, "The recording produced no transcript.");
    throw new Error("The recording produced no transcript.");
  }
  await log("ok", usage);
  return { transcript, engine: `${cfg.provider} · ${model}` };
}
