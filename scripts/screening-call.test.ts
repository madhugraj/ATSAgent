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
import { and, eq } from "drizzle-orm";

process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");
process.env["SIP_SERVER"] ??= "127.0.0.1";
process.env["SIP_USER"] ??= "3001";
process.env["SIP_PASSWORD"] ??= "test-only";

const realGateway = await import("../src/lib/ai-gateway.server");
/** What the grader was last given (system rules and the prompt). */
const lastGrade: { system?: string; prompt?: string } = {};
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: { feature: string; system?: string; prompt?: string }) => {
    if (opts.feature === "screening_grade")
      Object.assign(lastGrade, { system: opts.system, prompt: opts.prompt });
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
const session = await import("../src/server/voice/call-session.server");
const sched = await import("../src/server/voice/schedule");
const dispatcher = await import("../src/server/voice/dispatcher.server");
const settings = await import("../src/server/voice/settings.server");
const gw = await import("../src/lib/ai-gateway.server");

type VoiceOpts = Parameters<typeof gw.aiVoiceSession>[0];
type Step =
  | { say: "ai" | "caller"; text: string }
  | { tool: string; args: Record<string, unknown>; expectOk?: boolean };

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
  private resolveEnded!: () => void;
  readonly ended = new Promise<void>((r) => (this.resolveEnded = r));
  constructor(private fail: string | null = null) {}
  async dial(number: string) {
    this.dialled = number;
    if (this.fail) throw new Error(this.fail);
  }
  onAudio() {}
  play() {}
  clear() {}
  pendingSeconds() {
    return 0;
  }
  async hangup() {
    this.hungUp = true;
  }
  close() {}
  candidateHangsUp() {
    this.resolveEnded();
  }
}

/** A voice session that plays `steps` once the call is answered. */
function scriptedVoice(steps: Step[], seen: { opts?: VoiceOpts; results: unknown[] }) {
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
    const run = async () => {
      for (const s of steps) {
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
        sendAudio() {},
        sendText(text: string) {
          if (text.includes("picked up")) void run();
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
    limits: { silenceMs: 60_000, firstWordsMs: 60_000 },
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
    contactName: "Asha Rao",
    contactEmail: "careers@yavar.test",
    candidateFirstName: "Meera",
    cv: { currentCompany: "Acme", experienceYears: 7, location: "Bengaluru" },
    strengths: ["Kubernetes", "Go"],
    known: { notice: false, currentPay: false, expectedPay: false },
    emailDomain: "gmail.com",
    questions: brief.questionsForCall(KIT as never),
    maxMinutes: 10,
    nextSteps: "the hiring team will get back to you within two working days",
    callingHours: "Monday to Saturday, 10:00 to 19:00",
    ...over,
  });

  test("screening questions: never pay or logistics; the weightiest four", () => {
    expect(brief.questionsForCall(KIT as never).map((q) => q.id)).toEqual(["q1", "q2"]);
  });

  test("the HR call: who, why, consent with alternatives, the role, why them, details, questions", () => {
    const p = brief.callSystemPrompt(facts());
    expect(p).toContain(
      "You are Saranya, an AI recruiting assistant with Yavar's talent acquisition team",
    );
    expect(p).toContain('Your first words: "Hello, am I speaking with Meera?"');
    expect(p).toContain("you applied through Naukri on 20 October");
    expect(p).toContain("written assessment by e-mail, or a call from a person");
    expect(p).toContain("Keep the payments platform reliable as it grows.");
    expect(p).toContain("What fits from their CV: Kubernetes, Go");
    expect(p).toMatch(
      /Practical details, before anything technical[\s\S]*expected pay — ask afresh/,
    );
    expect(p).toContain("or skip the consent, politely");
    expect(p).toContain("(their CV says Acme, about 7 years — confirm it rather than read it out)");
    expect(p).toContain("the one ending in gmail.com");
    expect(p).toContain("[q1] Tell me about running Kubernetes in production.");
    expect(p).not.toContain("expected CTC is above our budget");
    expect(p).toContain("reflect the gist back");
    expect(p).toContain("Never answer a question yourself");
    expect(p).toContain('If they want to skip a question, say "Of course"');
    expect(p).toContain("do not answer from general knowledge");
    expect(p).toContain('not "great", "good", "impressive", "very comprehensive"');
    expect(p).toContain("ask afresh even if it was given before");
    expect(p).toContain("Whenever they mention a detail at any point in the call");
    expect(p).toContain("Discuss, judge or negotiate pay");
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
    expect(p).not.toContain("their notice period and the earliest date");
    expect(p).toContain("We have your notice period from earlier");
    expect(p).toContain("ask afresh even if it was given before");
    expect(p).toContain("Never tell them a detail is not needed");
    expect(p).toContain("at most once in the whole call");
    expect(p).toContain("I'm calling at the time we agreed");
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

  test("confidence follows how many planned questions were answered", () => {
    expect(session.callCoverage(4, 4)).toEqual({ planned: 4, answered: 4, confidence: "high" });
    expect(session.callCoverage(4, 3)).toMatchObject({ confidence: "high" });
    expect(session.callCoverage(4, 2)).toMatchObject({ confidence: "medium" });
    expect(session.callCoverage(4, 1)).toMatchObject({ confidence: "low" });
    expect(session.callCoverage(0, 0)).toMatchObject({ confidence: "low" });
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
    expect(brief.callSystemPrompt(facts({ appliedVia: null, appliedOn: null }))).toContain(
      "We came across your profile",
    );
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
    ).toMatchObject({ ok: true, answered: 1 });
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
        "I'm an AI assistant; I'll make notes for the team.",
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
            text: "This is Saranya, an AI recruiting assistant with Yavar's team. I'll make notes of our conversation for the hiring team. Is now a good time?",
          },
          { say: "caller", text: "Yes, go ahead, that's fine." },
          { tool: "record_answer", args: { question_id: "q1", summary: "too early" } },
          { tool: "record_consent", args: { granted: true, their_words: "Yes, go ahead." } },
          { say: "ai", text: "What is your notice period, and your current and expected pay?" },
          {
            say: "caller",
            text: "Thirty days. I earn 24 lakhs fixed and expect 32 lakhs. I live in Chennai.",
          },
          {
            tool: "record_details",
            args: {
              notice_period_days: 30,
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
          { say: "caller", text: "I led the payments outage postmortem." },
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
    expect(seen.opts!.turnTaking).toMatchObject({ endOfSpeech: "low", silenceMs: 1000 });
    expect(seen.opts!.languageCode).toBe("en-IN");
    // Refused before consent, and for the pay question.
    expect(
      seen.results.filter((x) => (x as { out: { ok: boolean } }).out.ok === false),
    ).toHaveLength(2);

    const c = await callRow(callId);
    expect(c).toMatchObject({ status: "completed", phoneLast4: "2345" });
    expect(c.answers.map((a) => a.question_id).sort()).toEqual(["q1", "q2"]);
    expect(c.consentWords).toBe("Yes, go ahead.");
    // Details on the call row — never pay.
    expect(c.details).toEqual({
      noticePeriodDays: 30,
      currentLocation: "Chennai",
      totalExperienceYears: 7,
      note: "Asked to keep it short.",
    });
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
    expect(graded!.coverage).toEqual({ planned: 2, answered: 2, confidence: "high" });
    // The desk thread hears how it went.
    const posted = await db
      .select({ agentType: hiringMessages.agentType, body: hiringMessages.body })
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, conv!.id));
    const fromCall = posted.filter((m) => m.agentType === "screening_call");
    expect(fromCall).toHaveLength(1);
    expect(fromCall[0]!.body).toMatch(/from 2 of 2 questions answered \(high confidence\)/);
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

  test("declined: nothing kept, the agent is told", async () => {
    const { callId, appId } = await seedCall();
    const r = await run(
      callId,
      new FakeLine(),
      scriptedVoice(
        [
          { say: "ai", text: "Is now a good time? I'll make notes for the hiring team." },
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
          text: "I'm an AI recruiting assistant and I'll make notes for the hiring team.",
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
