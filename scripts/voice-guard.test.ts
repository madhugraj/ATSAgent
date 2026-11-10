/**
 * The Voice Guard (docs/voice-guard.md): the line stats every call keeps, the
 * system's own checks, the merge that drops invented quotes, the mandatory
 * policy, and the sweep that queues, reviews (stats alone) and starts a run
 * for every answered call — against the disposable database.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/voice-guard.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");

const { db } = await import("../src/server/db");
const {
  agentPolicies,
  agentRuns,
  applications,
  callReviews,
  candidates,
  orgMembers,
  organizations,
  requisitions,
  screeningCalls,
  users,
} = await import("../drizzle/schema");
const { CallStatsTracker } = await import("../src/server/voice/call-stats");
const checks = await import("../src/server/voice/guard/checks");
const { voiceGuardPolicy, loadPolicy } = await import("../src/server/agents/policy");
const { ensureAgentsRegistered } = await import("../src/server/agents");
const review = await import("../src/server/voice/guard/review.server");

type Turn = { who: "ai" | "caller"; text: string; at: string };
const T0 = Date.parse("2026-11-10T05:30:00Z");
const turns = (...xs: ["ai" | "caller", string][]): Turn[] =>
  xs.map(([who, text], i) => ({ who, text, at: new Date(T0 + i * 10_000).toISOString() }));

/* ------------------------------------------------------------- pure */

describe("line stats", () => {
  test("who spoke first, talking over, replies, barge-ins", () => {
    let t = 0;
    const s = new CallStatsTracker(() => t);
    s.answered();
    t = 500;
    s.aiAudio(); // spoke before the hello
    t = 600;
    s.caller("start");
    t = 800;
    s.aiAudio(); // still the same utterance (< 400 ms)
    t = 2_000;
    s.aiAudio(); // a new utterance while the caller talks: talk-over
    t = 3_000;
    s.caller("end");
    t = 7_500;
    s.aiAudio(); // a 4.5 s reply
    s.bargeIn();
    const out = s.finish({ languageCode: "en-IN", audio: null });
    expect(out).toMatchObject({
      v: 1,
      languageCode: "en-IN",
      firstAiMs: 500,
      firstCallerMs: 600,
      aiSpokeFirst: true,
      callerSegments: 1,
      aiUtterances: 3,
      talkOver: 1,
      bargeIns: 1,
      slowReplies: 1,
      replyMs: { count: 1, p50: 4_500, max: 4_500 },
    });
  });
});

const base = (over: Partial<checks.GuardInput> = {}): checks.GuardInput => ({
  purpose: "screening",
  scope: "full",
  status: "completed",
  endReason: "completed",
  consentAt: new Date(T0 + 20_000),
  qualityDisclosed: true,
  transcript: turns(
    ["caller", "Hello?"],
    [
      "ai",
      "I'm Saranya, an AI recruiting assistant. I'll make notes for the hiring team, and the call is checked for quality.",
    ],
    ["caller", "Yes, go ahead."],
  ),
  answers: [],
  details: {
    required: { joining_date: "recorded", current_pay: "declined", expected_pay: "recorded" },
  },
  stats: null,
  ...over,
});

describe("the system's checks", () => {
  test("disclosure before consent — the quality line only for calls that ran with it", () => {
    const ok = checks.codeChecks(base());
    expect(ok.checks.find((c) => c.check === "disclosure")?.verdict).toBe("pass");
    const late = checks.codeChecks(
      base({
        transcript: turns(
          ["caller", "Hello?"],
          ["ai", "I'm an AI assistant and I'll make notes for the hiring team."],
          ["caller", "Sure."],
        ),
      }),
    );
    expect(late.findings[0]).toMatchObject({ check: "disclosure", severity: "critical" });
    // A call from before 0071 is held to the disclosure it had then.
    const older = checks.codeChecks(
      base({
        qualityDisclosed: false,
        transcript: turns(
          ["ai", "I'm an AI assistant and I'll make notes for the team."],
          ["caller", "OK"],
        ),
      }),
    );
    expect(older.checks.find((c) => c.check === "disclosure")?.verdict).toBe("pass");
  });

  test("required details: declined is fine, missing is a finding", () => {
    expect(
      checks.codeChecks(base()).checks.find((c) => c.check === "required_details"),
    ).toMatchObject({ verdict: "pass", note: "Declined: current pay." });
    const r = checks.codeChecks(
      base({
        details: {
          required: { joining_date: "missing", current_pay: "recorded", expected_pay: "missing" },
        },
      }),
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({
        check: "required_details",
        severity: "high",
        summary: "The call ended without the earliest joining date or expected pay.",
      }),
    );
    // Not a completed screen: nothing required.
    expect(
      checks
        .codeChecks(base({ status: "callback", endReason: "booked" }))
        .checks.find((c) => c.check === "required_details")?.verdict,
    ).toBe("not_applicable");
  });

  test("turn-taking from the line stats; a timing-only review covers the line alone", () => {
    const stats = {
      v: 1 as const,
      languageCode: "en-IN",
      firstCallerMs: 2_000,
      firstAiMs: 300,
      aiSpokeFirst: true,
      callerSegments: 6,
      aiUtterances: 8,
      talkOver: 2,
      bargeIns: 0,
      replyMs: { count: 6, p50: 1_500, p90: 9_000, max: 9_000 },
      slowReplies: 1,
      audio: { frames: 900, gaps: 6, lateTicks: 0, maxLateMs: 0 },
    };
    const r = checks.codeChecks(base({ scope: "timing_only", transcript: [], stats }));
    expect(r.checks.map((c) => c.check)).toEqual(["turn_taking"]);
    expect(r.findings.map((f) => [f.severity, f.summary])).toEqual([
      ["high", "It spoke before the candidate said hello."],
      ["high", "It started speaking while the candidate was still talking 2 times."],
      ["low", "Slow replies: 1 over 3 s, the slowest 9 s."],
      ["low", "Its voice broke up 6 times (audio ran out mid-sentence)."],
    ]);
  });

  test("word-for-word repeats, unless the candidate asked", () => {
    const rep = turns(
      ["ai", "Could you tell me about running Kubernetes in production?"],
      ["caller", "Hmm."],
      ["ai", "Could you tell me about running Kubernetes in production?"],
      ["caller", "Sorry, can you say that again?"],
      ["ai", "Could you tell me about running Kubernetes in production?"],
    );
    expect(checks.wordForWordRepeats(rep)).toEqual([
      { sentence: "Could you tell me about running Kubernetes in production?", turns: [0, 2] },
    ]);
  });

  test("a mistranscribed line is flagged; Hindi and Tamil are not", () => {
    const r = checks.codeChecks(
      base({
        transcript: turns(
          ["caller", "Sí, ¿cómo está?"],
          ["caller", "हाँ, ठीक है"],
          ["caller", "சரி"],
          ["caller", "Yes, 30 days."],
        ),
      }),
    );
    expect(r.findings.find((f) => f.check === "transcription")?.evidence).toEqual([
      { turn: 0, quote: "Sí, ¿cómo está?" },
    ]);
  });
});

describe("what the 10 November test call showed", () => {
  const call = turns(
    ["caller", "Hello."],
    [
      "ai",
      "This is Saranya, an AI recruiting assistant. I will make notes of our conversation for the hiring team, and the call is checked for quality. Is now a good time?",
    ],
    ["caller", "It is okay, but I have never applied for this post."],
    ["ai", "Sorry for the confusion. Would you still like to hear about it?"],
    ["caller", "Yes, of course."],
    ["ai", "Now for a few practical details."],
    ["caller", "Are you there?"],
    ["ai", "Yes, I am. Since the role is based in Bangalore, would you be open to relocating?"],
    ["caller", "Maybe."],
    ["ai", "Regarding your notice period and the earliest date you could join, could you tell me?"],
    ["caller", "3 months after successful completion of the interview."],
    ["ai", "Thank you."],
  );
  const r = checks.codeChecks(
    base({
      transcript: call,
      endReason: "silence",
      consentWords: "It is okay, but I have never applied for this post.",
      details: {
        required: { joining_date: "missing", current_pay: "missing", expected_pay: "missing" },
      },
      stats: {
        v: 1,
        languageCode: "en-IN",
        firstCallerMs: 900,
        firstAiMs: 1500,
        aiSpokeFirst: false,
        callerSegments: 6,
        aiUtterances: 6,
        talkOver: 0,
        bargeIns: 0,
        replyMs: { count: 5, p50: 1500, p90: 2000, max: 2000 },
        slowReplies: 0,
        audio: null,
        cues: { after_tool: 1, mid_turn: 1, reply: 0, unrecorded_note: 1 },
      },
    }),
  );
  const summaries = r.findings.map((f) => `${f.check}: ${f.summary}`);

  test("the stall at 'Are you there?' and the cut-off end", () => {
    expect(summaries).toContain(
      "turn_taking: It went quiet until the candidate had to ask whether it was still there.",
    );
    expect(summaries).toContain(
      "turn_taking: The assistant stopped speaking and the call was cut off (silence) without a close.",
    );
    expect(summaries).toContain(
      "turn_taking: It went quiet when it should have spoken and had to be cued 3 times (1 to record something it said it noted).",
    );
  });

  test("details asked and answered but not recorded; consent from a concerned reply", () => {
    expect(summaries).toContain(
      "record_accuracy: It asked whether they would relocate, the candidate answered, and nothing was recorded.",
    );
    expect(summaries).toContain(
      "record_accuracy: It asked their notice period, the candidate answered, and nothing was recorded.",
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({
        check: "record_accuracy",
        severity: "critical",
        evidence: [{ turn: 2, quote: "It is okay, but I have never applied for this post." }],
      }),
    );
  });

  test("required details asked together in one question", () => {
    expect(r.findings).toContainEqual(
      expect.objectContaining({
        check: "call_steps",
        severity: "high",
        summary:
          "It asked for notice period and joining date in one question instead of one at a time.",
        evidence: [
          {
            turn: 9,
            quote:
              "Regarding your notice period and the earliest date you could join, could you tell me?",
          },
        ],
      }),
    );
  });

  test("stacked: counts what each question asks for, not question marks", () => {
    const s = (text: string) => checks.stackedQuestions(turns(["ai", text])).map((x) => x.asks);
    expect(
      s(
        "Thank you. I have noted that. Now, to ensure our records are up to date, could you please share your current fixed and variable pay, as well as your expected pay?",
      ),
    ).toEqual([["current pay", "expected pay"]]);
    expect(s("What is your current and expected CTC?")).toEqual([["current pay", "expected pay"]]);
    expect(s("When could you join, and what is your expected salary?")).toEqual([
      ["joining date", "expected pay"],
    ]);
    // One detail per question is fine, even in one turn.
    expect(s("What is your notice period?")).toEqual([]);
    expect(s("Thank you. And what is your expected pay?")).toEqual([]);
    expect(s("You mentioned a notice period of 90 days. Which date could you join?")).toEqual([]);
    // A detail they already gave, as the premise, is not asked again (test call, 10 Nov).
    expect(
      s(
        "If your notice period is three months, what would be the specific earliest date you could join?",
      ),
    ).toEqual([]);
    expect(s("Given your notice period of 90 days, when could you join?")).toEqual([]);
    // Statements are not questions.
    expect(s("Now for your notice period and your expected pay.")).toEqual([]);
  });

  test("asked again: a required detail a third time; the same question after an answer", () => {
    const a = checks.askedAgain(
      turns(
        ["ai", "What is your notice period?"],
        ["caller", "It's almost 3 months."],
        ["ai", "Thank you. Which date could you join?"],
        ["caller", "It's almost 3 months."],
        ["ai", "If your notice period is three months, which date could you join?"],
        ["caller", "Calculate it from today."],
        ["ai", "Which date could you join, please?"],
      ),
    );
    expect(a.detail).toEqual([{ what: "joining date", turns: [2, 4, 6] }]);
    // Asked, a concern, then asked again word for word: the test call of 10 November.
    const b = checks.askedAgain(
      turns(
        ["ai", "The call is checked for quality. Is now a good time?"],
        ["caller", "You haven't told me how you got my profile."],
        ["ai", "The hiring team can share that. Is now a good time?"],
      ),
    );
    expect(b.same).toEqual([{ sentence: "Is now a good time?", turns: [0, 2] }]);
    // Repeating it because they asked is fine.
    const c = checks.askedAgain(
      turns(
        ["ai", "Is now a good time?"],
        ["caller", "Sorry, can you repeat that?"],
        ["ai", "Is now a good time?"],
      ),
    );
    expect(c.same).toEqual([]);
  });

  test("the source: flagged only on calls whose brief forbade it", () => {
    const call = turns([
      "ai",
      "I'm calling about your application for the Head of AI role — you applied on 9 November.",
    ]);
    const ran = (brief: string | null) =>
      checks
        .codeChecks(base({ transcript: call, brief }))
        .findings.filter((f) => f.check === "charter");
    expect(ran(`… ${checks.SOURCE_RULE} …`)).toEqual([
      expect.objectContaining({
        severity: "high",
        summary: "It said how the candidate's profile came to us.",
      }),
    ]);
    expect(ran("an older brief")).toEqual([]);
  });

  test("not held against calls made before the rule", () => {
    const old = checks.codeChecks(
      base({
        qualityDisclosed: false,
        transcript: turns(["ai", "What is your notice period and the date you could join?"]),
      }),
    );
    expect(old.findings.filter((f) => f.check === "call_steps")).toEqual([]);
  });

  test("the call's own steps are a check for calls made under them", () => {
    expect(checks.checksFor("screening", "full").map((c) => c.id)).toContain("call_steps");
    expect(checks.checksFor("screening", "full", true).map((c) => c.id)).not.toContain(
      "call_steps",
    );
  });
});

describe("merging the agent's review", () => {
  const transcript = turns(
    ["ai", "Tell me about Kubernetes, for example Helm or Argo CD?"],
    ["caller", "Yes, Helm."],
    ["ai", "You will hear from us by Friday."],
  );
  const code = { checks: [], findings: [] };

  test("quotes must be in the turn they name; invented ones are dropped", () => {
    const m = checks.mergeReview(
      "screening",
      "full",
      code,
      {
        checks: [{ check: "answer_clues", verdict: "breach" }],
        findings: [
          {
            check: "answer_clues",
            severity: "high",
            summary: "Named tools.",
            evidence: [{ turn: 0, quote: "for example Helm or Argo CD" }],
          },
          {
            check: "commitments",
            severity: "critical",
            summary: "Promised a shortlist.",
            // Not what turn 2 says.
            evidence: [{ turn: 2, quote: "you are shortlisted" }],
          },
          {
            check: "turn_taking",
            severity: "high",
            summary: "The agent cannot file a code check.",
            evidence: [{ turn: 0, quote: "Tell me about Kubernetes" }],
          },
        ],
        qualityScore: 2,
        summary: "x",
      },
      transcript,
    );
    expect(m.findings.map((f) => f.check)).toEqual(["answer_clues"]);
    expect(m.dropped).toBe(2);
    expect(m.verdict).toBe("breach");
    expect(m.checks.find((c) => c.check === "answer_clues")?.verdict).toBe("breach");
    expect(m.checks.find((c) => c.check === "commitments")?.verdict).toBe("pass");
  });

  test("verdict: low findings only are attention; none is a pass", () => {
    const low = checks.mergeReview(
      "screening",
      "full",
      code,
      {
        checks: [],
        findings: [
          {
            check: "repetition",
            severity: "low",
            summary: "Repeated.",
            evidence: [{ turn: 2, quote: "by Friday" }],
          },
        ],
        qualityScore: 4,
        summary: "x",
      },
      transcript,
    );
    expect([low.verdict, low.breaches]).toEqual(["attention", 0]);
    expect(
      checks.mergeReview(
        "scheduling",
        "full",
        code,
        { checks: [], findings: [], qualityScore: 5, summary: "x" },
        transcript,
      ).verdict,
    ).toBe("pass");
    // Screening-only checks do not apply to a scheduling call.
    expect(checks.checksFor("scheduling", "full").map((c) => c.id)).not.toContain("read_back");
    // An older call (no brief kept) is not held to rules that came with the Voice Guard.
    expect(checks.checksFor("screening", "full", true).map((c) => c.id)).not.toContain("read_back");
    expect(checks.checksFor("screening", "full").map((c) => c.id)).toContain("read_back");
  });
});

describe("mandatory policy", () => {
  test("on whenever a phone agent is on; never at Suggest; the org pause stops it", () => {
    const off = { enabled: false, autonomy: "suggest" as const };
    expect(voiceGuardPolicy(off, { orgPaused: false, voiceAgentOn: true })).toEqual({
      enabled: true,
      autonomy: "act_and_notify",
    });
    expect(voiceGuardPolicy(off, { orgPaused: false, voiceAgentOn: false }).enabled).toBe(false);
    expect(voiceGuardPolicy(off, { orgPaused: true, voiceAgentOn: true }).enabled).toBe(false);
    expect(
      voiceGuardPolicy(
        { enabled: true, autonomy: "autonomous" },
        { orgPaused: false, voiceAgentOn: false },
      ),
    ).toEqual({ enabled: true, autonomy: "autonomous" });
  });
});

/* ------------------------------------------------------------- the sweep */

const stamp = Date.now();
let orgId: string;
let userId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  ensureAgentsRegistered();
  userId = (
    await db
      .insert(users)
      .values({ email: `vg-${stamp}@test.local`, fullName: "Guard Owner" })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Guarded", slug: `vg-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: `vg-${stamp}@test.local`,
    status: "active",
    isOwner: true,
    joinedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

async function endedCall(o: { consented: boolean }) {
  const [req] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `VG-${Math.random().toString(36).slice(2, 7)}`,
      title: "Platform SRE",
      status: "approved",
    } as never)
    .returning({ id: requisitions.id });
  const [cand] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: "Meera",
      email: `m-${Math.random().toString(36).slice(2, 7)}@cand.local`,
    } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "shortlisted" } as never)
    .returning({ id: applications.id });
  const now = Date.now();
  const [c] = await db
    .insert(screeningCalls)
    .values({
      orgId,
      candidateId: cand!.id,
      applicationId: app!.id,
      requisitionId: req!.id,
      status: o.consented ? "completed" : "consent_declined",
      attempt: 1,
      startedAt: new Date(now - 120_000),
      endedAt: new Date(now - 60_000),
      consentAt: o.consented ? new Date(now - 110_000) : null,
      transcript: o.consented
        ? [
            {
              who: "ai",
              text: "Hello, I'm an AI assistant.",
              at: new Date(now - 115_000).toISOString(),
            },
          ]
        : [],
      callStats: {
        v: 1,
        languageCode: "en-IN",
        firstCallerMs: 900,
        firstAiMs: 400,
        aiSpokeFirst: true,
        callerSegments: 1,
        aiUtterances: 2,
        talkOver: 0,
        bargeIns: 0,
        replyMs: { count: 1, p50: 900, p90: 900, max: 900 },
        slowReplies: 0,
        audio: null,
      },
    })
    .returning({ id: screeningCalls.id });
  return c!.id;
}

describe("the sweep", () => {
  test("off while no phone agent is on; then every answered call is reviewed", async () => {
    const declined = await endedCall({ consented: false });
    const consented = await endedCall({ consented: true });
    expect(await review.sweepCallReviews({ orgId })).toEqual({
      queued: 0,
      timingOnly: 0,
      started: 0,
      retried: 0,
    });
    expect((await loadPolicy(orgId, "voice_guard")).enabled).toBe(false);

    await db.insert(agentPolicies).values({ orgId, agentType: "screening_call", enabled: true });
    expect(await loadPolicy(orgId, "voice_guard")).toMatchObject({
      enabled: true,
      autonomy: "act_and_notify",
    });
    const counts = await review.sweepCallReviews({ orgId });
    expect(counts).toMatchObject({ queued: 2, timingOnly: 1, started: 1 });

    // No consent: nothing was kept, so the line alone — by the system, no AI.
    const [t] = await db.select().from(callReviews).where(eq(callReviews.callId, declined));
    expect(t).toMatchObject({
      scope: "timing_only",
      status: "done",
      verdict: "breach",
      agentRunId: null,
    });
    expect(t!.findings[0]).toMatchObject({ check: "turn_taking", source: "code" });

    // A transcript: a Voice Guard run, acting for the owner, about this call.
    const [f] = await db.select().from(callReviews).where(eq(callReviews.callId, consented));
    expect(f).toMatchObject({ scope: "full", status: "reviewing", attempts: 1 });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, f!.agentRunId!));
    expect(run).toMatchObject({
      agentType: "voice_guard",
      principalUserId: userId,
      subjectType: "voice_call",
      subjectId: consented,
    });

    // Queued once only.
    expect((await review.sweepCallReviews({ orgId })).queued).toBe(0);

    // The run ended without filing: retried, then given up after three attempts.
    await db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, run!.id));
    await review.sweepCallReviews({ orgId });
    const [again] = await db.select().from(callReviews).where(eq(callReviews.callId, consented));
    expect(again).toMatchObject({ status: "reviewing", attempts: 2 });
    expect(again!.lastError).toContain("without filing a review");
    await db
      .update(callReviews)
      .set({ attempts: review.MAX_REVIEW_ATTEMPTS })
      .where(eq(callReviews.id, again!.id));
    await db
      .update(agentRuns)
      .set({ status: "failed" })
      .where(eq(agentRuns.id, again!.agentRunId!));
    await review.sweepCallReviews({ orgId });
    const [gaveUp] = await db.select().from(callReviews).where(eq(callReviews.callId, consented));
    expect(gaveUp).toMatchObject({ status: "failed" });

    // A person asks for it again.
    expect(await review.requeueReview(orgId, gaveUp!.id)).toBe(true);
    const [due] = await db
      .select()
      .from(callReviews)
      .where(and(eq(callReviews.orgId, orgId), eq(callReviews.id, gaveUp!.id)));
    expect(due).toMatchObject({ status: "due", attempts: 0 });

    // Dialled again (a retry reuses the call) and talked this time: reviewed again, in
    // full — a test call on 10 November kept the line-only review of its first attempt.
    await db
      .update(screeningCalls)
      .set({
        status: "completed",
        attempt: 2,
        consentAt: new Date(),
        endedAt: new Date(),
        transcript: [
          { who: "ai", text: "Hello, I'm an AI assistant.", at: new Date().toISOString() },
        ],
      })
      .where(eq(screeningCalls.id, declined));
    expect((await review.sweepCallReviews({ orgId })).queued).toBe(1);
    const [redialled] = await db.select().from(callReviews).where(eq(callReviews.callId, declined));
    expect(redialled).toMatchObject({ scope: "full", attempts: 1 });
    expect(redialled!.status).not.toBe("done");
    // …and only once.
    expect((await review.sweepCallReviews({ orgId })).queued).toBe(0);
  });

  test("another run cannot read or file a call it is not reviewing", async () => {
    const id = await endedCall({ consented: true });
    await db.insert(callReviews).values({ orgId, callId: id, purpose: "screening", scope: "full" });
    const { startRun } = await import("../src/server/agents/runtime.server");
    const start = async () =>
      (
        await startRun({
          orgId,
          agentType: "voice_guard",
          principalUserId: userId,
          goal: `Review call ${id}`,
          subjectType: "voice_call",
          subjectId: id,
        })
      ).runId;
    const runA = await start();
    const runB = await start();
    const packet = await review.reviewPacket(orgId, runA, id);
    // No brief kept: an older call, not held to the rules that came with the Voice Guard.
    expect(packet.yourChecks.map((c) => c.check)).not.toContain("read_back");
    expect(packet).toHaveProperty("olderCall");
    expect(packet.transcript[0]).toMatchObject({ turn: 0, who: "assistant" });
    expect(packet).not.toHaveProperty("model");
    await expect(review.reviewPacket(orgId, runB, id)).rejects.toThrow(
      "Another run is reviewing this call.",
    );
    await expect(
      review.fileReview(orgId, runB, id, {
        checks: [],
        findings: [],
        qualityScore: 3,
        summary: "x",
      }),
    ).rejects.toThrow("this run is not reviewing it");
  });
});
