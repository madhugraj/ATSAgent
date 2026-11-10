/**
 * The phone screening call (M2, docs/voice-screening-agent.md) against the
 * disposable database, with a fake phone line and a scripted voice session in
 * place of the PBX and the live model:
 *  - the brief: AI disclosure, facts only, no pay questions, client unnamed;
 *  - in-call tools: nothing recorded before consent, only kit questions,
 *    availability but never pay;
 *  - outcomes: completed (graded, availability recorded, transcript kept),
 *    consent declined (nothing kept), callback (inside the calling window),
 *    no answer (retried, then the e-mailed assessment), no usable number;
 *  - the calling window, retries and callbacks in the organisation's time zone;
 *  - the dispatcher: due, ready and inside the window only; one claim per call;
 *    calls a stopped worker left behind are recovered.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/screening-call.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");
process.env["SIP_SERVER"] ??= "127.0.0.1";
process.env["SIP_USER"] ??= "3001";
process.env["SIP_PASSWORD"] ??= "test-only";

const realGateway = await import("../src/lib/ai-gateway.server");
const { coverageWords, notReached } = await import("../src/lib/screening-coverage");
/** What the grader was last given (system rules and the prompt). */
const lastGrade: { system?: string; prompt?: string } = {};
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: { feature: string; system?: string; prompt?: string }) => {
    if (opts.feature === "screening_grade")
      Object.assign(lastGrade, { system: opts.system, prompt: opts.prompt });
    // The desk's judgement of a reason to go back a step: a dropped call is one.
    if (opts.feature === "hiring_desk") {
      const valid = /dropped|by mistake/i.test(opts.prompt ?? "");
      return {
        ok: true,
        data: {
          valid,
          why: valid
            ? "The last call dropped, so it was not a complete screen."
            : "Wanting a better score is not a reason to repeat a completed screen.",
        },
        model: "m",
        provider: "google",
        usage: null,
      };
    }
    return opts.feature === "screening_grade"
      ? {
          ok: true,
          data: {
            screening_score: 70,
            verdicts: [
              {
                question_id: "q1",
                verdict: "strong",
                score: 85,
                evidence: "Ran k8s",
                rationale: "ok",
              },
              {
                question_id: "q2",
                verdict: "partial",
                score: 55,
                evidence: "Some",
                rationale: "ok",
              },
            ],
            rationale: "Solid on platform work.",
            red_flags: [],
            recommendation: "advance",
            recommendation_reason: "Strong must-haves.",
          },
          model: "m",
          provider: "google",
          usage: null,
        }
      : { ok: false, status: 500, message: `no fixture for ${opts.feature}` };
  },
}));

const { db } = await import("../src/server/db");
const schema = await import("../drizzle/schema");
const {
  agentEvents,
  applications,
  auditLog,
  interviewSlotOffers,
  candidates,
  compensationDetails,
  emailOutbox,
  hiringConversations,
  hiringMessages,
  organizations,
  requisitions,
  screeningCalls,
  screeningKits,
  screeningRuns,
  users,
} = schema;
const brief = await import("../src/server/voice/call-brief.server");
const checks = await import("../src/server/voice/guard/checks");
const session = await import("../src/server/voice/call-session.server");
const sched = await import("../src/server/voice/schedule");
const dispatcher = await import("../src/server/voice/dispatcher.server");
const settings = await import("../src/server/voice/settings.server");
const gw = await import("../src/lib/ai-gateway.server");

type VoiceOpts = Parameters<typeof gw.aiVoiceSession>[0];
type Step =
  | { say: "ai" | "caller"; text: string }
  | { tool: string; args: Record<string, unknown>; expectOk?: boolean }
  /** The model goes quiet until the session cues it (text matching this), or 8 s. */
  | { waitCue: RegExp };

const stamp = Date.now();
let orgId: string;
let userId: string;
const TZ = "Asia/Kolkata";
const WIN = { windowStartMinute: 600, windowEndMinute: 1140, callDays: [1, 2, 3, 4, 5, 6] };
// Monday 26 October 2026, 11:00 IST — inside the window.
const MONDAY_11 = Date.parse("2026-10-26T05:30:00Z");

const KIT = [
  {
    id: "q1",
    focus: "must_have_skill",
    question: "Tell me about running Kubernetes in production.",
    reason: "must-have",
    expected_answer: "clusters, upgrades",
    weak_answer: "only tutorials",
    weight: 5,
  },
  {
    id: "q2",
    focus: "ownership",
    question: "Describe an incident you led.",
    reason: "ownership",
    expected_answer: "postmortem",
    weak_answer: "vague",
    weight: 3,
  },
  {
    id: "q3",
    focus: "logistics",
    question: "Your expected CTC is above our budget — is it flexible?",
    reason: "pay",
    expected_answer: "flexible",
    weak_answer: "no",
    weight: 4,
  },
];

/* ------------------------------------------------------------- fakes */

class FakeLine implements session.PhoneLine {
  dialled: string | null = null;
  hungUp = false;
  /** Set when placeCall attaches its audio handler; deliver() needs it. */
  audioCb: ((pcm: Int16Array) => void) | null = null;
  /** When set, the assistant's reply counts as queued (the VAD gate is closed). */
  hold = false;
  private resolveEnded!: () => void;
  readonly ended = new Promise<void>((r) => (this.resolveEnded = r));
  constructor(private fail: string | null = null) {}
  async dial(number: string) {
    this.dialled = number;
    if (this.fail) throw new Error(this.fail);
  }
  onAudio(cb: (pcm: Int16Array) => void) {
    this.audioCb = cb;
  }
  play() {}
  clear() {}
  pendingSeconds() {
    return this.hold ? 1 : 0;
  }
  async hangup() {
    this.hungUp = true;
  }
  close() {}
  candidateHangsUp() {
    this.resolveEnded();
  }
  /** Deliver one 20 ms frame from the caller's side. */
  deliver(pcm: Int16Array) {
    this.audioCb?.(pcm);
  }
}

/** A voice session that plays `steps` once the call is answered. */
function scriptedVoice(
  steps: Step[],
  seen: { opts?: VoiceOpts; results: unknown[]; sent?: number[]; cues?: string[] },
) {
  const cues: string[] = [];
  let onCue: (() => void) | null = null;
  return (async (opts: VoiceOpts) => {
    seen.opts = opts;
    const transcript: { who: "caller" | "ai"; text: string; at: string }[] = [];
    let close!: (s: gw.VoiceSessionSummary) => void;
    const done = new Promise<gw.VoiceSessionSummary>((r) => (close = r));
    const summary = (): gw.VoiceSessionSummary => ({
      transcript,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      closedBy: "client",
      error: null,
    });
    let started = false;
    const run = async () => {
      if (started) return;
      started = true;
      for (const s of steps) {
        if ("waitCue" in s) {
          const want = s.waitCue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 8_000);
            onCue = () => {
              if (cues.some((c) => want.test(c))) {
                clearTimeout(timer);
                resolve();
              }
            };
            onCue();
          });
          continue;
        }
        if ("say" in s) {
          const turn = { who: s.say, text: s.text, at: new Date().toISOString() };
          transcript.push(turn);
          opts.events?.onTurn?.(turn);
        } else {
          const out = await opts.events!.onToolCall!({ id: s.tool, name: s.tool, args: s.args });
          seen.results.push({ tool: s.tool, out });
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return {
      ok: true as const,
      session: {
        sendAudio(pcm?: Int16Array) {
          if (pcm && seen.sent) seen.sent.push(pcm.length);
        },
        sendText(text: string) {
          cues.push(text);
          seen.cues?.push(text);
          onCue?.();
          if (text.includes("picked up")) void run();
          // The ready-made greeting is asked for while the phone rings (greeting.ts): the
          // script plays from there, once the fake line has picked up.
          if (text.includes("phone is ringing")) setTimeout(() => void run(), 20);
        },
        close: async () => {
          const s = summary();
          close(s);
          return s;
        },
        done,
      },
    };
  }) as unknown as typeof gw.aiVoiceSession;
}

/* -------------------------------------------------------------- setup */

async function seedCall(over: { phone?: string | null; status?: string; attempt?: number } = {}) {
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-SC-${Math.random().toString(36).slice(2, 7)}`,
      title: "Platform SRE",
      status: "approved",
      location: "Chennai",
      workMode: "hybrid",
      createdBy: userId,
    } as never)
    .returning({ id: requisitions.id });
  const [cand] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: "Meera Krishnan",
      email: `meera-${Math.random().toString(36).slice(2, 7)}@cand.local`,
      phone: over.phone === undefined ? "+91 98400 12345" : over.phone,
    } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "shortlisted" } as never)
    .returning({ id: applications.id });
  const [kit] = await db
    .insert(screeningKits)
    .values({
      orgId,
      candidateId: cand!.id,
      requisitionId: req!.id,
      applicationId: app!.id,
      questions: KIT as never,
      focusSummary: "k8s",
    })
    .returning({ id: screeningKits.id });
  const [call] = await db
    .insert(screeningCalls)
    .values({
      orgId,
      candidateId: cand!.id,
      applicationId: app!.id,
      requisitionId: req!.id,
      kitId: kit!.id,
      status: (over.status ?? "dialling") as never,
      attempt: over.attempt ?? 1,
      dueAt: new Date(MONDAY_11 - 60_000),
    })
    .returning({ id: screeningCalls.id });
  return { callId: call!.id, appId: app!.id, candidateId: cand!.id };
}

const callRow = async (id: string) =>
  (await db.select().from(screeningCalls).where(eq(screeningCalls.id, id)))[0]!;

const endedEvents = async (appId: string) =>
  db
    .select({ payload: agentEvents.payload })
    .from(agentEvents)
    .where(and(eq(agentEvents.subjectId, appId), eq(agentEvents.type, "screening_call.ended")));

const run = (callId: string, line: FakeLine, voice: typeof gw.aiVoiceSession) =>
  session.runScreeningCall(orgId, callId, {
    line: () => line,
    voice,
    now: () => MONDAY_11,
    limits: { silenceMs: 60_000, firstWordsMs: 60_000, callerFirstMs: 0 },
  });

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `sc-${stamp}@test.local`, fullName: "Asha Rao" })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({
        name: "Yavar",
        slug: `sc-${stamp}`,
        status: "active",
        careersEmail: "careers@yavar.test",
      })
      .returning({ id: organizations.id })
  )[0]!.id;
  await settings.setPhoneScreeningPolicyCore(
    orgId,
    { userId, memberEmail: "hr@yavar.test" },
    { ...settings.DEFAULT_PHONE_SCREENING_POLICY, enabled: true, assistantName: "Saranya" },
  );
  await gw.writeProviderKey(orgId, "google", "test-key-not-real");
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  await db.delete(candidates).where(eq(candidates.orgId, orgId));
});

/* ------------------------------------------------------------- pure */

describe("the call brief", () => {
  const facts = (over: Partial<brief.BriefFacts> = {}): brief.BriefFacts => ({
    assistantName: "Saranya",
    orgName: "Yavar",
    roleTitle: "Platform SRE",
    roleCode: "REQ-1",
    place: "Chennai (Hybrid)",
    forClient: false,
    roleSummary: "Keep the payments platform reliable as it grows.",
    responsibilities: ["Run Kubernetes clusters", "Lead incident response"],
    appliedVia: "Naukri",
    appliedOn: "20 October",
    booked: false,
    reschedulesLeft: 2,
    contactEmail: "careers@yavar.test",
    candidateFirstName: "Meera",
    cv: { currentCompany: "Acme", experienceYears: 7, location: "Bengaluru" },
    strengths: ["Kubernetes", "Go"],
    known: { notice: false, currentPay: false, expectedPay: false },
    emailDomain: "gmail.com",
    questions: brief.questionsForCall(KIT as never),
    maxMinutes: 3,
    nextSteps: "the hiring team will get back to you within two working days",
    callingHours: "Monday to Saturday, 10:00 to 19:00",
    ...over,
  });

  test("screening questions: never pay or logistics; as many as the call allows", () => {
    expect(brief.questionsForCall(KIT as never).map((q) => q.id)).toEqual(["q1", "q2"]);
  });

  test("questions fit the call: two in 10 minutes, said without the CV lead-in", () => {
    expect(brief.callQuestionCount(10)).toBe(2);
    expect(brief.callQuestionCount(6)).toBe(1);
    expect(brief.callQuestionCount(20)).toBe(4);
    expect(
      brief.spokenQuestion(
        "While your profile details high-level model adaptation, how hands-on are you with Python today?",
      ),
    ).toBe("How hands-on are you with Python today?");
    expect(brief.spokenQuestion("How do you run incidents?")).toBe("How do you run incidents?");
  });

  test("9 November call: consent after a concern, no insisting, questions back answered", () => {
    const p = brief.callSystemPrompt(facts());
    expect(p).toContain('an earlier "yes" does not count once they have raised a concern');
    expect(p).toContain(brief.SOURCE_LINE);
    expect(p).toContain("record open_to_relocate only if they then say yes or no");
    expect(p).toContain("one open follow-up");
    expect(p).toContain('never answer a question with "Thank you, noted"');
  });

  test("the HR call: who, why, consent with alternatives, the role, why them, details, questions", () => {
    const p = brief.callSystemPrompt(facts());
    expect(p).toContain(
      "You are Saranya, an AI recruiting assistant with Yavar's talent acquisition team",
    );
    expect(p).toContain(
      'Your first words are said as they pick up: "Hello, am I speaking with Meera?"',
    );
    // The source is never mentioned (the organisation's rule, 10 November).
    expect(p).toContain(
      "calling about our Platform SRE role. I'll make notes of our conversation for the hiring team, and the call is checked for quality. Is now a good time for a quick 3 minutes call?",
    );
    expect(p).not.toContain("Naukri");
    expect(p).not.toContain("20 October");
    expect(p.toLowerCase()).toContain(checks.SOURCE_RULE);
    // 1.9.3: the call does the screening itself — it never offers a person or the
    // written assessment (offering them ended a test call at 33 s); only if they ask.
    expect(p).not.toContain("You can also choose");
    expect(p).toContain("Never offer a call from a person or the written assessment.");
    expect(p).toContain("Only if they ask for a person or the written assessment themselves");
    expect(p).toContain("Keep the payments platform reliable as it grows.");
    // 1.8.0, a 3-minute call: the role in one sentence, no "why them", one question of
    // about 45 s, their questions go to the hiring team by e-mail.
    expect(p).toContain("Never say they are a fit or praise them.");
    expect(p).not.toContain("What their CV mentions that the role works with");
    expect(p).toContain("One question about your experience — about 45 seconds, please.");
    expect(p).toContain("never after a full answer");
    expect(p).not.toContain("Do you have any questions for me?");
    expect(p).toContain("please reply to our e-mail and the hiring team will answer");
    expect(p).toMatch(
      /2\. Once they confirm, in one turn[\s\S]*3\. The role in one sentence[\s\S]*4\. Ask directly, one question each[\s\S]*a\. "What is your notice period\?"[\s\S]*b\. "Which date could you join\?"[\s\S]*c\. "What is your current CTC per year\?"[\s\S]*d\. "And your expected CTC per year\?"[\s\S]*5\. Ask where they live now[\s\S]*6\. "One question about your experience/,
    );
    // Each required detail is its own question (a real call stacked the paired items).
    // Title, company and years are on the CV: not asked.
    expect(p).not.toContain("their current job title");
    expect(p).not.toContain("years of experience");
    expect(p).toContain("or skip the consent, politely");
    expect(p).toContain("the one ending in gmail.com");
    expect(p).toContain("[q1] Tell me about running Kubernetes in production.");
    expect(p).not.toContain("expected CTC is above our budget");
    expect(p).toContain("never summarise, reflect or repeat what they said back");
    expect(p).toContain("Never answer a question yourself");
    expect(p).toContain('If they want to skip a question, say "Of course"');
    expect(p).toContain("do not answer from general knowledge");
    expect(p).toContain('not "great", "good", "impressive", "very comprehensive"');
    expect(p).toContain('Pay is always asked afresh ("so our notes are up to date")');
    expect(p).toContain("Whenever they mention or correct a detail at any point in the call");
    expect(p).toContain("Discuss pay, the role's budget or band, or any offer.");
    expect(p).toContain("within two working days");
  });

  test("known details are not asked again; a booked call says so; a client is never named", () => {
    const p = brief.callSystemPrompt(
      facts({
        known: { notice: true, currentPay: true, expectedPay: true },
        booked: true,
        forClient: true,
      }),
    );
    // The required details: one at a time, a clear answer, told why, never a third time.
    // 1.9.0: asked directly — no list read out first; the reason with the second ask.
    expect(p).toContain("never read out a list of them first");
    expect(p).toContain(brief.CONSEQUENCE_LINE);
    expect(p).toContain("Never work out a date or a figure for them");
    expect(p).toContain("Never ask for the same detail a third time");
    expect(p).toContain('ask only "Shall we go ahead?"');
    expect(p).not.toContain("We have your notice period from earlier");
    expect(p).toContain('Pay is always asked afresh ("so our notes are up to date")');
    expect(p).toContain("never tell them a detail is not needed");
    expect(p).toContain("at most once in the whole call");
    expect(p).toContain("calling at the time we agreed");
    expect(p).toContain("on behalf of a client");
  });

  test("blind grading: the candidate's name is removed, other words left alone", async () => {
    const { blindName } = await import("../src/lib/screening.functions");
    expect(
      blindName("Speaking with Meera? Yes, MEERA Krishnan here. Meeranath.", "Meera Krishnan"),
    ).toBe("Speaking with the candidate? Yes, the candidate here. Meeranath.");
    expect(blindName("No name here.", "")).toBe("No name here.");
  });

  test("no more moving the call once the limit is reached: alternatives instead", () => {
    const p = brief.callSystemPrompt(facts({ reschedulesLeft: 0 }));
    expect(p).toContain("already been moved as many times as allowed");
    expect(p).not.toContain("Call book_slot with the time they asked for");
  });

  test("coverage: planned, asked and answered; confidence follows answered / planned", () => {
    const four = ["q1", "q2", "q3", "q4"];
    expect(session.callCoverage(four, four, 4)).toEqual({
      planned: 4,
      asked: 4,
      answered: 4,
      plannedIds: four,
      askedIds: four,
      confidence: "high",
    });
    expect(session.callCoverage(four, four, 3)).toMatchObject({ confidence: "high" });
    expect(session.callCoverage(four, ["q1", "q2"], 2)).toMatchObject({ confidence: "medium" });
    expect(session.callCoverage(four, ["q1"], 1)).toMatchObject({ confidence: "low" });
    expect(session.callCoverage([], [], 0)).toMatchObject({ confidence: "low" });
  });

  test("coverage in words: asked versus planned, skips and questions not reached", () => {
    const c = (asked: string[], answered: number) =>
      session.callCoverage(["q1", "q2", "q3", "q4"], asked, answered);
    expect(coverageWords(c(["q1", "q2"], 2))).toBe(
      "2 asked of 4 planned · both answered · 2 not reached on the call",
    );
    expect(coverageWords(c(["q1", "q2", "q3", "q4"], 3))).toBe(
      "4 asked of 4 planned · 3 answered, 1 skipped by the candidate",
    );
    expect(coverageWords(c(["q1", "q2", "q3", "q4"], 4))).toBe(
      "4 asked of 4 planned · all answered",
    );
    expect(notReached(c(["q1", "q3"], 2))).toEqual(["q2", "q4"]);
    // Older runs recorded only planned and answered.
    expect(coverageWords({ planned: 4, answered: 2, confidence: "medium" })).toBe(
      "2 of 4 planned questions answered",
    );
    expect(notReached({ planned: 4, answered: 2, confidence: "medium" })).toEqual([]);
  });

  test("a question the candidate declines is asked, never graded", () => {
    const s = { ...session.freshCallState(), consent: true };
    const ids = new Set(["q1", "q2"]);
    expect(
      session.applyCallTool(
        s as never,
        "record_answer",
        { question_id: "q2", summary: "Preferred not to say.", declined: true },
        ids,
        0,
      ),
    ).toMatchObject({ ok: true, asked: 1 });
    expect(s.answers[0]).toMatchObject({ question_id: "q2", declined: true });
    // Only a declined question is not a completed screen.
    expect(session.callOutcome(s)).toBe("no_answer");
  });

  test("helpers: JD bullets, strengths, how they applied, calling hours", () => {
    expect(brief.bullets("- Run **clusters**\n2. Lead incidents\n\n• ok")).toEqual([
      "Run clusters",
      "Lead incidents",
    ]);
    expect(
      brief.strengthsFor(["Kubernetes", "Go", "Rust"], ["go", "kubernetes", "python"]),
    ).toEqual(["Kubernetes", "Go"]);
    expect(brief.appliedVia("apply")).toBe("our careers page");
    expect(brief.appliedVia("direct")).toBeNull();
    expect(brief.appliedVia("hiring_desk")).toBeNull();
    expect(brief.appliedVia("agent_talent_pool")).toBeNull();
    // How the profile came to us is never said — applied, referred or neither.
    expect(brief.appliedVia("referral")).toBe("a referral");
    for (const appliedVia of [null, "a referral", "Naukri"]) {
      const p = brief.callSystemPrompt(facts({ appliedVia }));
      expect(p).not.toContain("We came across your profile");
      expect(p).not.toContain("through a referral");
      expect(p).not.toContain("you applied");
    }
    expect(brief.callingHours(WIN)).toBe("Monday to Saturday, 10:00 to 19:00");
  });
});

describe("in-call tools", () => {
  const fresh = () => ({
    consent: null as boolean | null,
    details: null as Record<string, unknown> | null,
    answers: [] as { question_id: string; summary: string; at: string }[],
    booking: null as { whenLocal: string } | null,
    endReason: null as null | (typeof session.END_REASONS)[number],
  });
  const ids = new Set(["q1", "q2"]);

  test("nothing is recorded before consent; only listed questions; bad arguments refused", () => {
    const s = fresh();
    expect(
      session.applyCallTool(
        s as never,
        "record_answer",
        { question_id: "q1", summary: "x" },
        ids,
        0,
      ),
    ).toMatchObject({ ok: false });
    expect(
      session.applyCallTool(s as never, "record_details", { notice_period_days: 30 }, ids, 0),
    ).toMatchObject({ ok: false });
    expect(
      session.applyCallTool(
        s as never,
        "record_consent",
        { granted: true, their_words: "yes" },
        ids,
        0,
      ),
    ).toEqual({ ok: true });
    expect(
      session.applyCallTool(
        s as never,
        "record_answer",
        { question_id: "q3", summary: "pay" },
        ids,
        0,
      ),
    ).toMatchObject({ ok: false });
    expect(
      session.applyCallTool(
        s as never,
        "record_answer",
        { question_id: "q1", summary: "first" },
        ids,
        0,
      ),
    ).toMatchObject({ ok: true });
    expect(
      session.applyCallTool(
        s as never,
        "record_answer",
        { question_id: "q1", summary: "again" },
        ids,
        0,
      ),
    ).toMatchObject({ ok: true, asked: 1 });
    expect(s.answers[0]!.summary).toBe("again");
    expect(
      session.applyCallTool(s as never, "book_slot", { when_local: "monday 4pm" }, ids, 0),
    ).toMatchObject({
      ok: false,
    });
    expect(
      session.applyCallTool(s as never, "end_call", { reason: "because" }, ids, 0),
    ).toMatchObject({
      ok: false,
    });
    expect(session.applyCallTool(s as never, "hire_them", {}, ids, 0)).toMatchObject({ ok: false });
  });

  test("a yes counts only after the assistant said it is an AI and makes notes", () => {
    expect(session.disclosureMissing("Hello, am I speaking with Meera?")).toMatch(/AI.*notes/);
    expect(session.disclosureMissing("I'm Saranya, an AI recruiting assistant.")).toMatch(/notes/);
    expect(
      session.disclosureMissing("I'm an AI assistant and I'll make notes for the hiring team."),
    ).toMatch(/checked for quality/);
    expect(
      session.disclosureMissing(
        "I'm an AI assistant and I'll make notes for the hiring team; the call is checked for quality.",
      ),
    ).toBeNull();
    const s = fresh();
    const yes = { granted: true, their_words: "Sure" };
    expect(
      session.applyCallTool(
        s as never,
        "record_consent",
        yes,
        ids,
        0,
        "Hello, is now a good time?",
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/first tell them/),
    });
    expect(s.consent).toBeNull();
    expect(
      session.applyCallTool(
        s as never,
        "record_consent",
        yes,
        ids,
        0,
        "I'm an AI assistant; I'll make notes for the team, and the call is checked for quality.",
      ),
    ).toEqual({ ok: true });
    // Declining needs no disclosure.
    const t = fresh();
    expect(
      session.applyCallTool(
        t as never,
        "record_consent",
        { granted: false, their_words: "No" },
        ids,
        0,
        "",
      ),
    ).toEqual({ ok: true });
  });

  test("consent is their answer to the latest question, never a reply that raised a concern", () => {
    const said =
      "I'm an AI assistant; I'll make notes for the team, and the call is checked for quality.";
    const s = fresh();
    const yes = { granted: true, their_words: "It is okay" };
    // The 10 November call: consent taken from the reply that said they never applied.
    expect(
      session.applyCallTool(
        s as never,
        "record_consent",
        yes,
        ids,
        0,
        said,
        " It is okay, but I have never applied for this post.",
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/raised a concern/) });
    expect(s.consent).toBeNull();
    expect(
      session.applyCallTool(s as never, "record_consent", yes, ids, 0, said, " Yes, of course."),
    ).toEqual({ ok: true });
    expect(s.consentWords).toBe("Yes, of course.");
    for (const r of [
      "How did you get my number?",
      "I'm not sure, what is this about?",
      "I didn't apply anywhere.",
    ])
      expect(session.RAISES_CONCERN.test(r)).toBe(true);
    for (const r of ["Yes, go ahead.", "Sure, I have ten minutes.", "Okay, but quickly please."])
      expect(session.RAISES_CONCERN.test(r)).toBe(false);
  });

  test("a call cannot be moved more often than the organisation allows", () => {
    const s = { ...fresh(), reschedulesLeft: 0 };
    expect(
      session.applyCallTool(s as never, "book_slot", { when_local: "2026-10-26T16:00" }, ids, 0),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/written assessment/) });
    expect(s.booking).toBeNull();
    const t = { ...fresh(), reschedulesLeft: 1 };
    expect(
      session.applyCallTool(t as never, "book_slot", { when_local: "2026-10-26T16:00" }, ids, 0),
    ).toEqual({ ok: true });
  });

  test("details merge as they come; the model is told which fields, never the figures", () => {
    const s = { ...fresh(), consent: true };
    expect(
      session.applyCallTool(
        s as never,
        "record_details",
        { notice_period_days: 60, expected_ctc: 3200000 },
        ids,
        0,
      ),
    ).toEqual({ ok: true, recorded: ["notice_period_days", "expected_ctc"] });
    session.applyCallTool(s as never, "record_details", { current_location: "Chennai" }, ids, 0);
    expect(s.details).toEqual({
      notice_period_days: 60,
      expected_ctc: 3200000,
      current_location: "Chennai",
    });
  });

  test("a completed call cannot end without the joining date and pay", () => {
    const s = { ...fresh(), consent: true };
    const end = (st: unknown, reason = "completed") =>
      session.applyCallTool(st as never, "end_call", { reason }, ids, 0);
    expect(end(s)).toMatchObject({
      ok: false,
      missing: ["joining_date", "current_pay", "expected_pay"],
      error: expect.stringMatching(/earliest date they could join/),
    });
    expect(end(s, "other")).toMatchObject({ ok: false });
    expect(s.endReason).toBeNull();
    // Ending early for another reason is unaffected.
    expect(end({ ...fresh(), consent: true }, "prefers_human")).toEqual({ ok: true });
    // Before consent nothing is recorded, so nothing is required.
    expect(end(fresh())).toEqual({ ok: true });

    session.applyCallTool(
      s as never,
      "record_details",
      { earliest_joining: "2027-01-04", current_ctc_fixed: 1800000 },
      ids,
      0,
    );
    expect(end(s)).toMatchObject({ ok: false, missing: ["expected_pay"] });
    // Declined needs their words in pay_note.
    session.applyCallTool(
      s as never,
      "record_details",
      { not_given: [{ item: "expected_pay", why: "declined" }] },
      ids,
      0,
    );
    expect(end(s)).toMatchObject({ ok: false, missing: ["expected_pay"] });
    session.applyCallTool(
      s as never,
      "record_details",
      { pay_note: "prefers to discuss pay with HR" },
      ids,
      0,
    );
    expect(end(s)).toEqual({ ok: true });
    expect(s.endReason).toBe("completed");
  });

  test("not working excuses current pay only; a later value clears not_given", () => {
    const m = session.mandatoryMissing;
    expect(
      m({
        earliest_joining: "2027-01-04",
        expected_ctc: 600000,
        not_given: [{ item: "current_pay", why: "not_working" }],
      }),
    ).toEqual([]);
    expect(
      m({
        current_ctc_fixed: 1,
        expected_ctc: 1,
        not_given: [{ item: "joining_date", why: "not_working" }],
      }),
    ).toEqual(["joining_date"]);
    expect(
      m({
        current_ctc_fixed: 1,
        expected_ctc: 1,
        candidate_note: "will know after appraisal",
        not_given: [{ item: "joining_date", why: "declined" }],
      }),
    ).toEqual([]);

    const s = { ...fresh(), consent: true };
    session.applyCallTool(
      s as never,
      "record_details",
      { pay_note: "rather not say", not_given: [{ item: "expected_pay", why: "declined" }] },
      ids,
      0,
    );
    session.applyCallTool(s as never, "record_details", { expected_ctc: 2400000 }, ids, 0);
    expect((s.details as { not_given?: unknown } | null)?.not_given).toBeUndefined();
  });

  test("a required detail is declined only after they were told what it means (10 November)", () => {
    const s = { ...fresh(), consent: true };
    let said = "Next, four details the hiring team needs. What is your current CTC per year?";
    const details = (args: object) =>
      session.applyCallTool(s as never, "record_details", args, ids, 0, said);
    const declineCurrent = {
      pay_note: "will talk to the HR",
      not_given: [{ item: "current_pay", why: "declined" }],
    };
    // "I will talk to the HR": not taken yet — the note is kept, the decline is not.
    const first = details(declineCurrent);
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("cannot consider") });
    expect(s.details).toMatchObject({ pay_note: "will talk to the HR" });
    expect((s.details as { not_given?: unknown }).not_given).toBeUndefined();
    // Told, and asked once more: their second no is taken.
    said +=
      " Without your current CTC, the hiring team cannot consider your application. Could you share it?";
    expect(details(declineCurrent)).toMatchObject({ ok: true });
    expect((s.details as { not_given?: unknown }).not_given).toEqual([
      { item: "current_pay", why: "declined" },
    ]);
    // The next detail needs its own telling: the one before does not carry over.
    said += " Understood. And what is your expected CTC per year?";
    expect(details({ not_given: [{ item: "expected_pay", why: "declined" }] })).toMatchObject({
      ok: false,
    });
    // Not working is never pressed; nor are text-mode runs (no spoken lines).
    expect(details({ not_given: [{ item: "current_pay", why: "not_working" }] })).toMatchObject({
      ok: true,
    });
    const t = { ...fresh(), consent: true };
    expect(
      session.applyCallTool(t as never, "record_details", declineCurrent, ids, 0),
    ).toMatchObject({ ok: true });
  });

  test("outcomes", () => {
    const o = session.callOutcome;
    const answered = {
      ...fresh(),
      consent: true,
      answers: [{ question_id: "q1", summary: "", at: "" }],
    };
    expect(o(answered as never)).toBe("completed");
    expect(o({ ...fresh(), consent: false } as never)).toBe("consent_declined");
    expect(o({ ...fresh(), booking: { whenLocal: "2026-10-26T16:00" } } as never)).toBe("booked");
    expect(o({ ...fresh(), consent: true, endReason: "prefers_written" } as never)).toBe(
      "prefers_written",
    );
    expect(o({ ...fresh(), consent: true, endReason: "prefers_human" } as never)).toBe(
      "prefers_human",
    );
    expect(o({ ...fresh(), consent: true, endReason: "not_interested" } as never)).toBe(
      "not_interested",
    );
    expect(o({ ...fresh(), endReason: "voicemail" } as never)).toBe("no_answer");
    expect(o(fresh() as never)).toBe("no_answer");
    expect(o({ ...fresh(), endReason: "wrong_person" } as never)).toBe("wrong_person");
  });
});

describe("the calling window (Asia/Kolkata, Mon–Sat 10:00–19:00)", () => {
  const ist = (s: string) => Date.parse(`${s}+05:30`);
  test("inside, before, near closing, Sunday", () => {
    expect(sched.inWindow(ist("2026-10-23T15:00:00"), WIN, TZ)).toBe(true);
    expect(sched.inWindow(ist("2026-10-23T08:00:00"), WIN, TZ)).toBe(false);
    expect(sched.inWindow(ist("2026-10-23T18:55:00"), WIN, TZ)).toBe(false);
    expect(sched.inWindow(ist("2026-10-25T12:00:00"), WIN, TZ)).toBe(false);
  });
  test("next start, retries and callbacks", () => {
    expect(sched.nextWindowStart(ist("2026-10-23T08:00:00"), WIN, TZ).getTime()).toBe(
      ist("2026-10-23T10:00:00"),
    );
    expect(sched.nextWindowStart(ist("2026-10-24T20:00:00"), WIN, TZ).getTime()).toBe(
      ist("2026-10-26T10:00:00"),
    );
    expect(sched.retryAt(ist("2026-10-23T18:00:00"), 1, WIN, TZ).getTime()).toBe(
      ist("2026-10-24T10:00:00"),
    );
    expect(sched.retryAt(ist("2026-10-23T15:00:00"), 2, WIN, TZ).getTime()).toBe(
      ist("2026-10-24T11:00:00"),
    );
    expect(
      sched.callbackAt("2026-10-24T11:30", ist("2026-10-23T15:00:00"), WIN, TZ).getTime(),
    ).toBe(ist("2026-10-24T11:30:00"));
    expect(
      sched.callbackAt("2026-10-25T11:30", ist("2026-10-23T15:00:00"), WIN, TZ).getTime(),
    ).toBe(ist("2026-10-26T10:00:00"));
    expect(sched.callbackAt("tomorrow", ist("2026-10-23T15:00:00"), WIN, TZ).getTime()).toBe(
      ist("2026-10-23T17:00:00"),
    );
    expect(sched.afterAttempt("no_answer", 3, 3, ist("2026-10-23T15:00:00"), WIN, TZ)).toEqual({
      status: "fell_back",
      dueAt: null,
    });
  });
});

/* -------------------------------------------------------- full calls */

describe("a whole call with a fake line", () => {
  test("a silent assistant after recording an answer is cued to go on (the 10 November call)", async () => {
    const { callId, appId } = await seedCall();
    const seen: { opts?: VoiceOpts; results: unknown[]; cues: string[] } = {
      results: [],
      cues: [],
    };
    const line = new FakeLine();
    const r = await run(
      callId,
      line,
      scriptedVoice(
        [
          {
            say: "ai",
            text: "This is Saranya, an AI recruiting assistant. I'll make notes of our conversation for the hiring team, and the call is checked for quality. Is now a good time?",
          },
          { say: "caller", text: "Yes, go ahead." },
          { tool: "record_consent", args: { granted: true, their_words: "Yes, go ahead." } },
          { say: "ai", text: "Tell me about running Kubernetes in production." },
          { say: "caller", text: "I run three EKS clusters." },
          // As on the real call: a short acknowledgement, the record, then silence.
          { say: "ai", text: "Thank you." },
          {
            tool: "record_answer",
            args: { question_id: "q1", summary: "Runs three EKS clusters." },
          },
          { waitCue: /waiting in silence/ },
          { say: "ai", text: "Describe an incident you led." },
          { say: "caller", text: "I would rather stop here, bye." },
          { say: "ai", text: "Of course. Thank you for your time, goodbye." },
          { tool: "end_call", args: { reason: "candidate_left" } },
        ],
        seen,
      ),
    );
    expect(seen.cues.filter((c) => /waiting in silence/.test(c))).toHaveLength(1);
    expect(r.endReason).toBe("candidate_left");
    const c = await callRow(callId);
    expect(c.callStats?.cues).toMatchObject({ after_tool: 1 });
    // Every ending checks the required details: the Screening agent is told what is missing.
    const [ev] = await endedEvents(appId);
    expect(ev?.payload).toMatchObject({
      missingDetails: ["the earliest joining date", "current pay", "expected pay"],
      cutOff: false,
    });
    expect(
      session.missingRequired({
        required: { joining_date: "declined", current_pay: "recorded", expected_pay: "missing" },
      }),
    ).toEqual(["expected pay"]);
  });

  test("completed: details first (pay to HR only), questions graded without them, agent told", async () => {
    const { callId, appId } = await seedCall();
    // The role's hiring-desk thread, where the call reports how it went.
    const [app] = await db
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(eq(applications.id, appId));
    const [conv] = await db
      .insert(hiringConversations)
      .values({
        orgId,
        requisitionId: app!.requisitionId,
        createdBy: userId,
        title: "Platform SRE",
      } as never)
      .returning({ id: hiringConversations.id });
    const seen: { opts?: VoiceOpts; results: unknown[] } = { results: [] };
    const line = new FakeLine();
    const r = await run(
      callId,
      line,
      scriptedVoice(
        [
          { say: "ai", text: "Hello, am I speaking with Meera?" },
          { say: "caller", text: "Yes, speaking." },
          {
            say: "ai",
            text: "This is Saranya, an AI recruiting assistant with Yavar's team. I'll make notes of our conversation for the hiring team, and the call is checked for quality. Is now a good time?",
          },
          { say: "caller", text: "Yes, go ahead, that's fine." },
          { tool: "record_answer", args: { question_id: "q1", summary: "too early" } },
          { tool: "record_consent", args: { granted: true, their_words: "Yes, go ahead." } },
          { say: "ai", text: "What is your notice period, and your current and expected pay?" },
          {
            say: "caller",
            text: "Thirty days, so I could join on 4 January. I earn 24 lakhs fixed and expect 32 lakhs. I live in Chennai.",
          },
          {
            tool: "record_details",
            args: {
              notice_period_days: 30,
              earliest_joining: "2027-01-04",
              current_ctc_fixed: 2400000,
              expected_ctc: 3200000,
              current_location: "Chennai",
              total_experience_years: 7,
              pay_note: "plus 10 lakhs in shares",
              candidate_note: "Asked to keep it short.",
            },
          },
          { say: "ai", text: "Thank you, noted. Tell me about running Kubernetes in production." },
          { say: "caller", text: "I run three EKS clusters." },
          {
            tool: "record_answer",
            args: { question_id: "q1", summary: "Runs three EKS clusters." },
          },
          { tool: "record_answer", args: { question_id: "q3", summary: "Wants 40 LPA" } },
          // A 3-minute call plans one question (1.8.0): another id is refused.
          {
            tool: "record_answer",
            args: { question_id: "q2", summary: "Led a payments outage postmortem." },
          },
          { say: "ai", text: "Thank you, goodbye!" },
          { tool: "end_call", args: { reason: "completed" } },
        ],
        seen,
      ),
    );
    expect(r).toMatchObject({ status: "completed", endReason: "completed" });
    expect(line.dialled).toBe("9840012345");
    expect(line.hungUp).toBe(true);
    expect(seen.opts!.feature).toBe("screening_call");
    expect(seen.opts!.system).toContain("Current local time:");
    expect(seen.opts!.system).not.toContain("expected CTC is above our budget");
    expect(seen.opts!.voice).toBe("Kore");
    expect(seen.opts!.turnTaking).toMatchObject({ endOfSpeech: "low", silenceMs: 1600 });
    expect(seen.opts!.languageCode).toBe("en-IN");
    // Refused before consent, for the pay question, and for a question not planned.
    expect(
      seen.results.filter((x) => (x as { out: { ok: boolean } }).out.ok === false),
    ).toHaveLength(3);

    const c = await callRow(callId);
    expect(c).toMatchObject({ status: "completed", phoneLast4: "2345" });
    expect(c.answers.map((a) => a.question_id).sort()).toEqual(["q1"]);
    // The words heard after the question, not the model's paraphrase.
    expect(c.consentWords).toBe("Yes, go ahead, that's fine.");
    // Details on the call row — never pay.
    expect(c.details).toEqual({
      noticePeriodDays: 30,
      earliestJoining: "2027-01-04",
      currentLocation: "Chennai",
      totalExperienceYears: 7,
      note: "Asked to keep it short.",
      // Where each required detail stands — never the figures.
      required: { joining_date: "recorded", current_pay: "recorded", expected_pay: "recorded" },
    });
    // The Voice Guard's inputs: the call's stats (no words) and what it ran with.
    expect(c.callStats).toMatchObject({ v: 1, languageCode: "en-IN" });
    expect(c.brief).toContain("checked for quality");
    expect(c.screeningRunId).toBe(r.screeningRunId);

    // The grader sees the screening part only — not pay, location or consent.
    const [graded] = await db
      .select()
      .from(screeningRuns)
      .where(eq(screeningRuns.id, r.screeningRunId!));
    expect(graded).toMatchObject({
      inputKind: "phone_ai",
      createdBy: null,
      recommendation: "advance",
    });
    expect(graded!.transcript).toContain("Candidate: I run three EKS clusters.");
    expect(graded!.transcript).not.toMatch(/lakhs|Chennai|go ahead/);
    // Blind, content-only grading.
    expect(lastGrade.system).toContain("Fairness rules (mandatory)");
    expect(lastGrade.system).toMatch(/Never let tone, manner/);
    expect(lastGrade.prompt).not.toMatch(/Meera|Krishnan/);
    // Spoken rubric, and only the questions the candidate answered (never pay or logistics).
    expect(lastGrade.system).toContain("Spoken-answer rubric");
    expect(lastGrade.prompt).toContain('"question_id":"q1"');
    expect(lastGrade.prompt).not.toContain('"question_id":"q3"');
    expect(graded!.coverage).toMatchObject({
      planned: 1,
      asked: 1,
      answered: 1,
      confidence: "high",
    });
    // The desk thread hears how it went.
    const posted = await db
      .select({ agentType: hiringMessages.agentType, body: hiringMessages.body })
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, conv!.id));
    const fromCall = posted.filter((m) => m.agentType === "screening_call");
    expect(fromCall).toHaveLength(1);
    expect(fromCall[0]!.body).toContain("(1 asked of 1 planned · answered; high confidence)");
    // …with the result card that opens "Why this score".
    const card = (
      await db
        .select({ card: hiringMessages.card })
        .from(hiringMessages)
        .where(eq(hiringMessages.conversationId, conv!.id))
    ).find((m) => (m.card as { type?: string } | null)?.type === "screening_result");
    expect(card?.card).toMatchObject({ runId: r.screeningRunId, applicationId: appId });
    // No amounts anywhere on the thread.
    expect(JSON.stringify(posted)).not.toMatch(/lakhs|3200000|2400000/);

    // Pay goes to the HR-only record; the audit names fields, never amounts.
    const pay = await db
      .select()
      .from(compensationDetails)
      .where(eq(compensationDetails.applicationId, appId));
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({
      source: "screening_call",
      noticePeriodDays: 30,
      enteredBy: null,
    });
    expect(Number(pay[0]!.currentFixed)).toBe(2400000);
    expect(Number(pay[0]!.expectedCtc)).toBe(3200000);
    expect(pay[0]!.note).toBe("plus 10 lakhs in shares");
    const [audit] = await db
      .select({ actor: auditLog.actor, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "compensation.recorded")));
    expect(audit!.actor).toBe("agent:screening_call");
    expect(JSON.stringify(audit!.detail)).not.toMatch(/2400000|3200000|Chennai/);

    expect((await endedEvents(appId))[0]!.payload).toMatchObject({ status: "completed" });
  });

  test("while the assistant is playing, its echo is held and a real interruption passes whole", async () => {
    const { callId } = await seedCall();
    const seen: { opts?: VoiceOpts; results: unknown[]; sent?: number[] } = {
      results: [],
      sent: [],
    };
    const line = new FakeLine();
    // The assistant's reply is queued: upstream gets only what the VAD calls
    // speech, so line noise and speakerphone echo cannot read as an interruption.
    line.hold = true;
    const done = run(callId, line, scriptedVoice([], seen));
    for (let i = 0; i < 200 && !line.audioCb; i++) await new Promise((r) => setTimeout(r, 5));
    // Nothing goes upstream until the ready-made greeting is released (greeting.ts) —
    // here at the first watchdog tick, as the limits give the hello no wait.
    await new Promise((r) => setTimeout(r, 300));
    const quiet = new Int16Array(160); // a 20 ms frame of line silence
    for (let i = 0; i < 10; i++) line.deliver(quiet);
    expect(seen.sent).toEqual([]);
    // 1.9.2: our line decides the turns (turn-detector.ts). While the assistant is
    // playing, 200 ms of speech is held — it may be the line echoing it back.
    const loud = new Int16Array(160).fill(2000); // the caller starts talking
    for (let i = 0; i < 10; i++) line.deliver(loud);
    expect(seen.sent).toEqual([]);
    // Sustained, clearly louder speech is them cutting in: passed on whole — the held
    // start and the 140 ms before it — resampled 8 → 16 kHz (doubled).
    for (let i = 0; i < 30; i++) line.deliver(loud);
    expect(seen.sent!.length).toBe(7 + 40);
    expect(new Set(seen.sent)).toEqual(new Set([320]));
    line.candidateHangsUp();
    await done;
  });

  test("declined: nothing kept, the agent is told", async () => {
    const { callId, appId } = await seedCall();
    const r = await run(
      callId,
      new FakeLine(),
      scriptedVoice(
        [
          {
            say: "ai",
            text: "Is now a good time? I'll make notes for the hiring team, and the call is checked for quality.",
          },
          { say: "caller", text: "No, please don't." },
          { tool: "record_consent", args: { granted: false, their_words: "No, please don't." } },
          { tool: "end_call", args: { reason: "declined" } },
        ],
        { results: [] },
      ),
    );
    expect(r.status).toBe("consent_declined");
    const c = await callRow(callId);
    expect(c.transcript).toEqual([]);
    expect(c.answers).toEqual([]);
    expect(c.details).toEqual({});
    expect(c.consentAt).toBeNull();
    expect(await endedEvents(appId)).toHaveLength(1);
  });

  test("not now: a time is agreed inside the window and e-mailed to the candidate", async () => {
    const { callId, appId } = await seedCall();
    const r = await run(
      callId,
      new FakeLine(),
      scriptedVoice(
        [
          { say: "caller", text: "I'm driving — can you call me tomorrow at 4 pm?" },
          { tool: "book_slot", args: { when_local: "2026-10-27T16:00" } },
          { tool: "end_call", args: { reason: "booked" } },
        ],
        { results: [] },
      ),
    );
    expect(r.status).toBe("callback");
    const c = await callRow(callId);
    expect(c.bookedByCandidate).toBe(true);
    expect(c.reschedules).toBe(1);
    expect(c.dueAt!.toISOString()).toBe("2026-10-27T10:30:00.000Z");
    const mail = await db
      .select({ kind: emailOutbox.kind, data: emailOutbox.templateData })
      .from(emailOutbox)
      .where(eq(emailOutbox.applicationId, appId));
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ kind: "screening_call_booked" });
    expect(JSON.stringify(mail[0]!.data)).toContain("Tuesday 27 October at 16:00");
    expect(await endedEvents(appId)).toHaveLength(0);
  });

  test("they ask for a person: no AI call, no assessment fall-back reason lost", async () => {
    const { callId, appId } = await seedCall();
    const r = await run(
      callId,
      new FakeLine(),
      scriptedVoice(
        [
          { say: "caller", text: "I'd rather speak to a person, please." },
          { tool: "end_call", args: { reason: "prefers_human" } },
        ],
        { results: [] },
      ),
    );
    expect(r).toMatchObject({ status: "fell_back", endReason: "prefers_human" });
    expect((await endedEvents(appId))[0]!.payload).toMatchObject({
      status: "fell_back",
      endReason: "prefers_human",
    });
  });

  test("no answer: tried again later, then the e-mailed assessment", async () => {
    const first = await seedCall({ attempt: 1 });
    const r1 = await run(
      first.callId,
      new FakeLine("no answer"),
      scriptedVoice([], { results: [] }),
    );
    expect(r1.status).toBe("no_answer");
    expect((await callRow(first.callId)).dueAt!.getTime()).toBe(MONDAY_11 + 2 * 3600_000);
    expect(await endedEvents(first.appId)).toHaveLength(0);

    const last = await seedCall({ attempt: 3 });
    const r3 = await run(
      last.callId,
      new FakeLine("486 Busy Here"),
      scriptedVoice([], { results: [] }),
    );
    expect(r3.status).toBe("fell_back");
    expect((await endedEvents(last.appId))[0]!.payload).toMatchObject({ status: "fell_back" });
  });

  test("no usable number: straight to the e-mailed assessment, never dialled", async () => {
    const { callId } = await seedCall({ phone: "+1 415 555 0100" });
    const line = new FakeLine();
    const r = await run(callId, line, scriptedVoice([], { results: [] }));
    expect(r).toMatchObject({ status: "fell_back", endReason: "no_number" });
    expect(line.dialled).toBeNull();
  });

  test("the candidate hangs up after consenting and answering: what was said is kept", async () => {
    const { callId } = await seedCall();
    const line = new FakeLine();
    const voice = scriptedVoice(
      [
        {
          say: "ai",
          text: "I'm an AI recruiting assistant and I'll make notes for the hiring team; the call is checked for quality.",
        },
        { tool: "record_consent", args: { granted: true, their_words: "Yes, go ahead." } },
        { say: "caller", text: "I run EKS." },
        { tool: "record_answer", args: { question_id: "q1", summary: "Runs EKS." } },
      ],
      { results: [] },
    );
    const done = run(callId, line, voice);
    setTimeout(() => line.candidateHangsUp(), 200);
    expect((await done).status).toBe("completed");
  });
});

describe("the dispatcher", () => {
  test("claims due calls once, inside the window, for a ready organisation", async () => {
    const { callId } = await seedCall({ status: "approved", attempt: 0 });
    expect(await dispatcher.claimDueCalls(2, new Date(MONDAY_11 - 3 * 3600_000))).toEqual([]); // 08:00 IST
    const claimed = await dispatcher.claimDueCalls(2, new Date(MONDAY_11));
    expect(claimed).toEqual([{ orgId, callId }]);
    expect(await callRow(callId)).toMatchObject({ status: "dialling", attempt: 1 });
    expect(await dispatcher.claimCall(orgId, callId)).toBe(false);
  });

  test("a requested callback does not use up an attempt; a switched-off org waits", async () => {
    const { callId } = await seedCall({ status: "callback", attempt: 3 });
    expect(await dispatcher.claimDueCalls(2, new Date(MONDAY_11))).toEqual([{ orgId, callId }]);
    expect((await callRow(callId)).attempt).toBe(3);

    const waiting = await seedCall({ status: "approved", attempt: 0 });
    await settings.setPhoneScreeningPolicyCore(
      orgId,
      { userId, memberEmail: "hr@yavar.test" },
      {
        ...settings.DEFAULT_PHONE_SCREENING_POLICY,
        enabled: false,
      },
    );
    expect(await dispatcher.claimDueCalls(2, new Date(MONDAY_11))).toEqual([]);
    expect((await callRow(waiting.callId)).status).toBe("approved");
    await settings.setPhoneScreeningPolicyCore(
      orgId,
      { userId, memberEmail: "hr@yavar.test" },
      {
        ...settings.DEFAULT_PHONE_SCREENING_POLICY,
        enabled: true,
      },
    );
  });

  test("calls a stopped worker left behind are recovered", async () => {
    const { callId } = await seedCall({ status: "in_progress" });
    await db
      .update(screeningCalls)
      .set({ updatedAt: new Date(Date.now() - 3600_000) })
      .where(eq(screeningCalls.id, callId));
    expect(await dispatcher.recoverStuckCalls(new Date())).toBe(1);
    expect(await callRow(callId)).toMatchObject({ status: "failed" });
  });
});

describe("the hiring desk", () => {
  test("'call again' arranges a screening call with the role's last candidate (10 November)", async () => {
    const desk = await import("../src/server/desk/desk.server");
    const { orgMembers, userRoles } = await import("../drizzle/schema");
    // Only TA, the HR head or the CBO may arrange a call — as the "Call now" button.
    await db
      .insert(orgMembers)
      .values({ orgId, userId, email: `sc-${stamp}@test.local`, status: "active" } as never)
      .onConflictDoNothing();
    await db.insert(userRoles).values({ userId, orgId, role: "recruiter" }).onConflictDoNothing();
    const { appId } = await seedCall({ status: "completed", attempt: 1 });
    const [app] = await db
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(eq(applications.id, appId));
    const [conv] = await db
      .insert(hiringConversations)
      .values({
        orgId,
        requisitionId: app!.requisitionId,
        createdBy: userId,
        title: "Platform SRE",
      } as never)
      .returning();
    const last = async () =>
      (
        await db
          .select({ body: hiringMessages.body })
          .from(hiringMessages)
          .where(eq(hiringMessages.conversationId, conv!.id))
      ).at(-1)?.body;
    const approved = () =>
      db
        .select({ id: screeningCalls.id })
        .from(screeningCalls)
        .where(and(eq(screeningCalls.applicationId, appId), eq(screeningCalls.status, "approved")));
    // Going back a step (a completed screen) needs a reason — asked for, then judged.
    await desk.callCandidateFromDesk(conv as never, userId, {});
    expect(await last()).toMatch(/needs a reason — why should .* be called again\?/);
    await desk.callCandidateFromDesk(conv as never, userId, { reason: "the score is low" });
    expect(await last()).toMatch(/^I won't repeat .*Wanting a better score/);
    expect(await approved()).toEqual([]);
    const refused = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "desk.go_back_refused")));
    expect(refused.at(-1)?.detail).toMatchObject({ reason: "the score is low" });
    // A real reason: arranged, and the reason is on the call's audit entry.
    await desk.callCandidateFromDesk(conv as never, userId, {
      reason: "the call dropped halfway through",
    });
    expect(await last()).toMatch(
      /^Arranged an AI screening call with .*Reason accepted: The last call dropped/,
    );
    const requested = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "screening_call.requested")));
    expect(requested.at(-1)?.detail).toMatchObject({
      again: true,
      reason: "the call dropped halfway through",
    });
    const calls = await db
      .select({ status: screeningCalls.status, requestedBy: screeningCalls.requestedBy })
      .from(screeningCalls)
      .where(and(eq(screeningCalls.applicationId, appId), eq(screeningCalls.status, "approved")));
    expect(calls).toEqual([{ status: "approved", requestedBy: userId }]);
    // Asked again while that call is waiting: said plainly, no second call.
    await desk.callCandidateFromDesk(conv as never, userId, { reason: "the call dropped again" });
    const again = await db
      .select({ body: hiringMessages.body })
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, conv!.id));
    expect(again.at(-1)?.body).toMatch(/already arranged/);
  });
});

describe("going back a step on the desk (the organisation's rule)", () => {
  test("moving a candidate back needs a reason judged valid; forward moves are not this", async () => {
    const desk = await import("../src/server/desk/desk.server");
    const { orgMembers, userRoles } = await import("../drizzle/schema");
    await db
      .insert(orgMembers)
      .values({ orgId, userId, email: `sc-${stamp}@test.local`, status: "active" } as never)
      .onConflictDoNothing();
    await db.insert(userRoles).values({ userId, orgId, role: "recruiter" }).onConflictDoNothing();
    const { appId } = await seedCall({ status: "completed", attempt: 1 });
    await db.update(applications).set({ stage: "rejected" }).where(eq(applications.id, appId));
    const [app] = await db
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(eq(applications.id, appId));
    const [conv] = await db
      .insert(hiringConversations)
      .values({
        orgId,
        requisitionId: app!.requisitionId,
        createdBy: userId,
        title: "SRE",
      } as never)
      .returning();
    const last = async () =>
      (
        await db
          .select({ body: hiringMessages.body })
          .from(hiringMessages)
          .where(eq(hiringMessages.conversationId, conv!.id))
      ).at(-1)?.body;
    const stage = async () =>
      (
        await db
          .select({ s: applications.stage })
          .from(applications)
          .where(eq(applications.id, appId))
      )[0]!.s;
    const back = {
      step: "move_candidate" as const,
      name: "Meera",
      toStage: "shortlisted" as const,
    };
    await desk.goBackFromDesk(conv as never, userId, back);
    expect(await last()).toMatch(/needs a reason — why\?/);
    await desk.goBackFromDesk(conv as never, userId, {
      ...back,
      reason: "she might do better now",
    });
    expect(await last()).toMatch(/^I won't move .* back for that reason:/);
    expect(await stage()).toBe("rejected");
    await desk.goBackFromDesk(conv as never, userId, {
      ...back,
      reason: "she was rejected by mistake",
    });
    expect(await last()).toMatch(/^Moved .* back from Rejected to Shortlisted\. Reason accepted:/);
    expect(await stage()).toBe("shortlisted");
    // A move forward is not going back: refused here, nothing judged.
    await desk.goBackFromDesk(conv as never, userId, {
      ...back,
      toStage: "l1",
      reason: "by mistake",
    });
    expect(await last()).toMatch(/is not going back a step/);
    expect(await stage()).toBe("shortlisted");
    // Mid-funnel back (L1 → screening): the flow allows it only from On hold — so through it.
    await db.update(applications).set({ stage: "l1" }).where(eq(applications.id, appId));
    await desk.goBackFromDesk(conv as never, userId, {
      ...back,
      toStage: "applied",
      reason: "her L1 was scheduled by mistake",
    });
    expect(await last()).toMatch(
      /^Moved .* back from Interview L1 to Applied \(through On hold, as the flow requires\)/,
    );
    expect(await stage()).toBe("applied");
    // Re-scoring replaces every score: a reason first, judged.
    await desk.goBackFromDesk(conv as never, userId, { step: "rescore" });
    expect(await last()).toMatch(
      /^Re-scoring replaces every candidate's current score, so it needs a reason/,
    );
    await desk.goBackFromDesk(conv as never, userId, {
      step: "rescore",
      reason: "scores look low",
    });
    expect(await last()).toMatch(/^I won't re-score the candidates for that reason:/);
    const audits = await db
      .select({ action: auditLog.action, detail: auditLog.detail })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          inArray(auditLog.action, ["desk.go_back_allowed", "desk.go_back_refused"]),
        ),
      );
    expect(audits.filter((a) => (a.detail as { step: string }).step === "move_back")).toHaveLength(
      3,
    );
    expect(audits.filter((a) => (a.detail as { step: string }).step === "rescore")).toHaveLength(1);
  });
});

describe("who is never called", () => {
  test("a candidate who asked not to be called: waiting calls cancelled, never requested or dialled", async () => {
    const optOut = await import("../src/server/voice/opt-out.server");
    const request = await import("../src/server/voice/request.server");
    const { callId, appId, candidateId } = await seedCall({ status: "approved", attempt: 0 });
    expect(
      await optOut.recordAiCallOptOut({
        orgId,
        candidateId,
        source: "call",
        actor: "screening call",
        callId,
      }),
    ).toBe(1);
    expect(await callRow(callId)).toMatchObject({ status: "cancelled" });
    expect(await optOut.aiCallOptedOut(orgId, candidateId)).toBe(true);
    // Recording it twice changes nothing and audits once.
    expect(
      await optOut.recordAiCallOptOut({ orgId, candidateId, source: "team", actor: "hr" }),
    ).toBe(0);
    const audits = await db
      .select({ action: auditLog.action, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, candidateId)));
    expect(audits.filter((a) => a.action === "candidate.ai_call_opt_out")).toHaveLength(1);

    expect(await request.checkScreeningCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/asked not to be called by the AI assistant/),
    });
    // Even a call that slipped through is never claimed or dialled.
    await db
      .update(screeningCalls)
      .set({ status: "approved" })
      .where(eq(screeningCalls.id, callId));
    expect(await dispatcher.claimDueCalls(2, new Date(MONDAY_11))).toEqual([]);
    expect(await dispatcher.claimCall(orgId, callId)).toBe(false);
    await db
      .update(screeningCalls)
      .set({ status: "dialling" })
      .where(eq(screeningCalls.id, callId));
    const line = new FakeLine();
    expect(await run(callId, line, scriptedVoice([], { results: [] }))).toMatchObject({
      status: "fell_back",
      endReason: "opted_out",
    });
    expect(line.dialled).toBeNull();

    // They asked to be called again: a person clears it (audited).
    expect(
      await optOut.clearAiCallOptOut({ orgId, candidateId, actor: "hr", actorUserId: userId }),
    ).toBe(true);
    expect(await optOut.aiCallOptedOut(orgId, candidateId)).toBe(false);
  });

  test("scheduling calls wait for their agent; the database keeps their shape", async () => {
    const { callId } = await seedCall({ status: "approved", attempt: 0 });
    // Not without the offer it follows up.
    let refused = false;
    try {
      await db
        .update(screeningCalls)
        .set({ purpose: "scheduling" })
        .where(eq(screeningCalls.id, callId));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    // At most three alternates.
    refused = false;
    try {
      await db
        .update(screeningCalls)
        .set({ alternates: ["a", "b", "c", "d"] })
        .where(eq(screeningCalls.id, callId));
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    // A scheduling call (with its offer) is not dialled before the Scheduling call agent ships.
    const [offer] = await db
      .insert(interviewSlotOffers)
      .values({
        orgId,
        applicationId: (await callRow(callId)).applicationId!,
        level: 1,
        interviewerEmail: "panel@yavar.test",
        slots: [new Date(MONDAY_11 + 2 * 864e5).toISOString()],
        token: `t-${Math.random().toString(36).slice(2)}`,
        expiresAt: new Date(MONDAY_11 + 864e5),
      })
      .returning({ id: interviewSlotOffers.id });
    await db
      .update(screeningCalls)
      .set({ purpose: "scheduling", slotOfferId: offer!.id })
      .where(eq(screeningCalls.id, callId));
    expect(await dispatcher.claimDueCalls(2, new Date(MONDAY_11))).toEqual([]);
  });
});
