/**
 * The voice scheduling call, step S1 (docs/voice-scheduling-call-plan.md),
 * against the disposable database:
 *  - the in-call tools' rules (pure): permission first, the AI disclosure,
 *    booking by option number only, outcomes;
 *  - the bookable options and the prompt;
 *  - when a call may be asked for: switched on, the wait (or a repeat offer),
 *    a day ahead, the opt-out, one per offer — and the alternates it carries;
 *  - the trigger: unanswered offers raise one event each;
 *  - the text-mode tools: a chosen option is really booked through the offer,
 *    "none of these work" takes the decline path, an opt-out is honoured.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/scheduling-call.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");
process.env["SIP_SERVER"] ??= "127.0.0.1";
process.env["SIP_USER"] ??= "3001";
process.env["SIP_PASSWORD"] ??= "test-only";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  agentRuns,
  applications,
  candidates,
  interviewSlotOffers,
  interviews,
  orgMembers,
  organizations,
  requisitions,
  screeningCalls,
  users,
} = await import("../drizzle/schema");
const tools = await import("../src/server/voice/scheduling-call-tools");
const brief = await import("../src/server/voice/scheduling-brief.server");
const prompt = await import("../src/server/voice/scheduling-prompt");
const request = await import("../src/server/voice/scheduling-request.server");
const outcome = await import("../src/server/voice/scheduling-outcome.server");
const settings = await import("../src/server/voice/settings.server");
const gw = await import("../src/lib/ai-gateway.server");
const registry = await import("../src/server/agents/registry");
const { registerSchedulingCallTools } = await import("../src/server/agents/tools-scheduling-call");
const session = await import("../src/server/voice/call-session.server");
const dispatcher = await import("../src/server/voice/dispatcher.server");

const stamp = Date.now();
// Calling hours all day, every day, so call-back rules do not depend on the clock.
const ALL_HOURS = {
  ...settings.DEFAULT_PHONE_SCREENING_POLICY,
  windowStartMinute: 0,
  windowEndMinute: 1440,
  callDays: [1, 2, 3, 4, 5, 6, 7],
};
const H = 3600_000;
const interviewer = `sched-${stamp}@test.local`;
let orgId: string;
let userId: string;
let reqId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (await db.insert(users).values({ email: interviewer }).returning({ id: users.id }))[0]!
    .id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Sched Org", slug: `sched-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: interviewer,
    fullName: "Priya Natarajan",
    status: "active",
    isOwner: true,
  } as never);
  reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-SC-${stamp}`,
        title: "Platform SRE",
        status: "approved",
        createdBy: userId,
      })
      .returning({ id: requisitions.id })
  )[0]!.id;
  await gw.writeProviderKey(orgId, "google", "test-api-key-not-real");
  registry.resetRegistry();
  registerSchedulingCallTools();
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await settings.setPhoneScreeningPolicyCore(
    orgId,
    { userId, memberEmail: interviewer },
    { ...ALL_HOURS, enabled: true, schedulingEnabled: true },
  );
});

/** The n-th weekday from today at 11:00 IST (05:30 UTC) — distinct for distinct n. */
function weekday(n: number) {
  const d = new Date();
  for (let left = n; left > 0;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (![0, 6].includes(d.getUTCDay())) left--;
  }
  d.setUTCHours(5, 30, 0, 0);
  return d.toISOString();
}

async function candidateApp(o: { phone?: string | null } = {}) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: "Meera Krishnan",
      email: `meera-${Math.random().toString(36).slice(2, 8)}@cand.local`,
      phone: o.phone === undefined ? "+91 98400 12345" : o.phone,
    } as never)
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l1" } as never)
    .returning({ id: applications.id });
  return { appId: a!.id, candidateId: c!.id };
}

async function offer(
  appId: string,
  o: { ageHours?: number; slots?: string[]; status?: string } = {},
) {
  const [row] = await db
    .insert(interviewSlotOffers)
    .values({
      orgId,
      applicationId: appId,
      level: 1,
      interviewerName: "Priya Natarajan",
      interviewerEmail: interviewer,
      slots: o.slots ?? [weekday(3), weekday(4), weekday(5)],
      token: `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      status: o.status ?? "offered",
      expiresAt: new Date(Date.now() + 3 * 864e5),
      createdAt: new Date(Date.now() - (o.ageHours ?? 30) * H),
    })
    .returning();
  return row!;
}

/** A real run of the Scheduling call agent (calls point at their run). */
async function newRun() {
  const [r] = await db
    .insert(agentRuns)
    .values({ orgId, agentType: "scheduling_call", principalUserId: userId, goal: "t" } as never)
    .returning({ id: agentRuns.id });
  return r!.id;
}

const ctx = (runId: string) => ({
  orgId,
  principalUserId: userId,
  runId,
  agentType: "scheduling_call" as const,
  actor: `agent:scheduling_call:${runId}`,
});

/* ------------------------------------------------------------ pure rules */

describe("the in-call tools", () => {
  const options = [weekday(3), weekday(4)];

  test("permission first, after saying it is an AI; then only listed options", () => {
    const s = tools.freshSchedulingState();
    expect(
      tools.applySchedulingTool(s, "book_interview_time", { option: 1 }, options),
    ).toMatchObject({ ok: false });
    expect(
      tools.applySchedulingTool(
        s,
        "record_permission",
        { granted: true, their_words: "yes" },
        options,
        "Hello, this is Saranya from the team.",
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/AI recruiting assistant/) });
    expect(
      tools.applySchedulingTool(
        s,
        "record_permission",
        { granted: true, their_words: "yes" },
        options,
        "This is Saranya, an AI recruiting assistant. I'll note the time you choose.",
      ),
    ).toEqual({ ok: true });
    expect(
      tools.applySchedulingTool(s, "book_interview_time", { option: 3 }, options),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/no option 3/) });
    // A free-form time is not even a valid argument.
    expect(
      tools.applySchedulingTool(s, "book_interview_time", { when: "tomorrow 9am" }, options),
    ).toMatchObject({ ok: false });
    expect(tools.applySchedulingTool(s, "book_interview_time", { option: 2 }, options)).toEqual({
      ok: true,
      book: options[1],
    });
  });

  test("a call-back: once, 5 to 180 minutes, only after the go-ahead", () => {
    const s = { ...tools.freshSchedulingState(), permission: true, callbackAllowed: true };
    for (const minutes of [4, 181])
      expect(
        tools.applySchedulingTool(s, "call_back_later", { minutes, their_words: "x" }, options),
      ).toMatchObject({ ok: false });
    expect(
      tools.applySchedulingTool(s, "call_back_later", { minutes: 10, their_words: "x" }, options),
    ).toEqual({ ok: true, callBackIn: 10 });
    const used = { ...tools.freshSchedulingState(), permission: true, callbackAllowed: false };
    expect(
      tools.applySchedulingTool(
        used,
        "call_back_later",
        { minutes: 10, their_words: "x" },
        options,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/already arranged/) });
    expect(
      tools.schedulingOutcome({
        permission: true,
        booked: null,
        availability: null,
        callback: { minutes: 10 },
        endReason: "callback",
      }),
    ).toBe("callback");
  });

  test("outcomes", () => {
    const base = { permission: true, booked: null, availability: null, endReason: null };
    expect(tools.schedulingOutcome({ ...base, endReason: "opt_out" })).toBe("opt_out");
    expect(tools.schedulingOutcome({ ...base, booked: { option: 1, at: "x" } })).toBe("booked");
    expect(tools.schedulingOutcome({ ...base, availability: { their_words: "mornings" } })).toBe(
      "availability_noted",
    );
    expect(tools.schedulingOutcome({ ...base, permission: false })).toBe("not_now");
    expect(tools.schedulingOutcome({ ...base, permission: null, endReason: "voicemail" })).toBe(
      "no_answer",
    );
    expect(outcome.scheduledEnd("voicemail", 1)).toBe("retry");
    expect(outcome.scheduledEnd("voicemail", 2)).toBe("fell_back");
    expect(outcome.scheduledEnd("opt_out", 1)).toBe("completed");
  });

  test("bookable options: offered first, then ≤3 alternates; too soon or repeated dropped", () => {
    const now = Date.now();
    const soon = new Date(now + H).toISOString();
    const o = brief.bookableOptions(
      [weekday(3), soon, weekday(4)],
      [weekday(4), weekday(6), weekday(7), weekday(8), weekday(9)],
      now,
      2 * H,
    );
    expect(o.map((x) => x.alternate)).toEqual([false, false, true, true]);
    expect(o.map((x) => x.at)).toEqual([weekday(3), weekday(4), weekday(6), weekday(7)]);
  });

  test("the prompt numbers the times, marks alternates, and never invents", () => {
    const p = prompt.schedulingSystemPrompt({
      assistantName: "Saranya",
      orgName: "Yavar",
      candidateFirstName: "Meera",
      roleTitle: "Platform SRE",
      roundLabel: "first-round interview",
      durationMins: 60,
      format: "online (video call)",
      interviewerName: "Priya",
      options: [
        { spoken: "Tuesday 27 October at 11:00", alternate: false },
        { spoken: "Thursday 29 October at 15:00", alternate: true },
      ],
      maxMinutes: 4,
      isCallback: false,
      callbackAllowed: true,
    });
    expect(p).toContain("1. Tuesday 27 October at 11:00");
    expect(p).toContain("call_back_later");
    expect(p).toContain("2. Thursday 29 October at 15:00 (not in the e-mail — also free)");
    expect(p).toContain("AI recruiting assistant");
    expect(p).toMatch(/Book, suggest or agree any time that is not in your list/);
    expect(p).toMatch(/Discuss pay, screening results/);
  });
});

/* ------------------------------------------------- when a call may happen */

describe("asking for a scheduling call", () => {
  test("every rule is the system's", async () => {
    const { appId, candidateId } = await candidateApp();
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/No interview times are waiting/),
    });
    // Sent 3 hours ago: waits for the organisation's 24 hours.
    const fresh = await offer(appId, { ageHours: 3 });
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/less than 24 hours ago; .* about 21 hours/),
    });
    // A person arranging the call may call sooner; an agent never may.
    expect(
      await request.checkSchedulingCall(orgId, appId, Date.now(), { byPerson: true }),
    ).toMatchObject({ ok: true, repeat: false });
    await db.delete(interviewSlotOffers).where(eq(interviewSlotOffers.id, fresh.id));
    // A repeat offer (the earlier one was declined) is called about at once.
    await offer(appId, { ageHours: 50, status: "declined" });
    const repeat = await offer(appId, { ageHours: 1 });
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: true,
      repeat: true,
    });
    // Off for the organisation.
    await settings.setPhoneScreeningPolicyCore(
      orgId,
      { userId, memberEmail: interviewer },
      { ...settings.DEFAULT_PHONE_SCREENING_POLICY, enabled: true, schedulingEnabled: false },
    );
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/switched off/),
    });
    await settings.setPhoneScreeningPolicyCore(
      orgId,
      { userId, memberEmail: interviewer },
      { ...settings.DEFAULT_PHONE_SCREENING_POLICY, enabled: true, schedulingEnabled: true },
    );
    // Asked for: one call per offer, with alternates not already offered.
    const r = await request.requestSchedulingCall({
      orgId,
      applicationId: appId,
      requestedBy: userId,
      requestedRunId: null,
      actor: interviewer,
    });
    const [call] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, r.callId));
    expect(call).toMatchObject({
      purpose: "scheduling",
      slotOfferId: repeat.id,
      status: "approved",
    });
    expect(call!.alternates.length).toBeLessThanOrEqual(3);
    for (const a of call!.alternates) expect(repeat.slots).not.toContain(a);
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already arranged/),
    });
    // The opt-out wins over everything.
    await db
      .update(candidates)
      .set({ aiCallOptOutAt: new Date() })
      .where(eq(candidates.id, candidateId));
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/asked not to be called/),
    });
  });

  test("one conversation per round for agents; a person may call again", async () => {
    const { appId, candidateId } = await candidateApp();
    const first = await offer(appId, { ageHours: 30 });
    await db.insert(screeningCalls).values({
      orgId,
      candidateId,
      applicationId: appId,
      requisitionId: reqId,
      purpose: "scheduling",
      slotOfferId: first.id,
      status: "completed",
      endReason: "not_now",
      consentAt: new Date(),
    });
    await db
      .update(interviewSlotOffers)
      .set({ status: "cancelled" })
      .where(eq(interviewSlotOffers.id, first.id));
    await offer(appId, { ageHours: 30, slots: [weekday(4), weekday(6)] });
    expect(await request.checkSchedulingCall(orgId, appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already spoke with them about this round/),
    });
    expect(
      await request.checkSchedulingCall(orgId, appId, Date.now(), { byPerson: true }),
    ).toMatchObject({ ok: true });
  });

  test("too close, or nobody to dial", async () => {
    const a = await candidateApp();
    await offer(a.appId, { slots: [new Date(Date.now() + 10 * H).toISOString(), weekday(3)] });
    expect(await request.checkSchedulingCall(orgId, a.appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/less than a day away/),
    });
    const b = await candidateApp({ phone: "+1 415 555 0100" });
    await offer(b.appId);
    expect(await request.checkSchedulingCall(orgId, b.appId)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no Indian mobile/),
    });
  });

  test("the trigger: an offer unanswered past the wait raises one event", async () => {
    const { appId } = await candidateApp();
    const o = await offer(appId, { ageHours: 30 });
    expect(await request.raiseUnansweredOffers(Date.now(), orgId)).toBeGreaterThanOrEqual(1);
    expect(await request.raiseUnansweredOffers(Date.now(), orgId)).toBe(0);
    const ev = await db
      .select({ payload: agentEvents.payload })
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.slots_no_reply")));
    expect(ev.map((e) => (e.payload as { offerId: string }).offerId)).toContain(o.id);
  });
});

/* ------------------------------------------------------ the text-mode tools */

describe("on the call (text mode)", () => {
  async function liveCall(o: { permission?: boolean } = {}) {
    const { appId, candidateId } = await candidateApp();
    const of = await offer(appId);
    const [call] = await db
      .insert(screeningCalls)
      .values({
        orgId,
        candidateId,
        applicationId: appId,
        requisitionId: reqId,
        purpose: "scheduling",
        slotOfferId: of.id,
        alternates: [weekday(7)],
        status: "in_progress",
        attempt: 1,
        ...(o.permission ? { consentAt: new Date(), consentWords: "Yes." } : {}),
      })
      .returning();
    return { call: call!, offer: of, appId, candidateId };
  }
  const run = (name: string, input: unknown, runId: string) =>
    registry.getTool(name)!.run(ctx(runId), input);

  test("a chosen option is booked through the e-mailed offer and read back", async () => {
    const { call, offer: of, appId } = await liveCall();
    const runId = await newRun();
    await expect(run("book_interview_time", { option: 1 }, runId)).rejects.toThrow(
      /record their answer/,
    );
    await run("record_permission", { granted: true, their_words: "Sure." }, runId);
    const r = (await run("book_interview_time", { option: 4 }, runId)) as { booked_for: string };
    expect(r.booked_for).toMatch(/at 11:00$/);
    const [iv] = await db.select().from(interviews).where(eq(interviews.applicationId, appId));
    expect(iv!.scheduledAt.toISOString()).toBe(weekday(7)); // the alternate
    const [o] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, of.id));
    expect(o!.status).toBe("booked");
    await run("end_scheduling_call", { reason: "booked" }, runId);
    const [c] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, call.id));
    expect(c).toMatchObject({ status: "completed", endReason: "booked" });
    expect(c!.consentWords).toBe("Sure.");
  });

  test("none of these work: their words go down the decline path", async () => {
    const { call, offer: of } = await liveCall({ permission: true });
    const runId = await newRun();
    await run("record_availability", { their_words: "weekday mornings before 10" }, runId);
    const [o] = await db
      .select()
      .from(interviewSlotOffers)
      .where(eq(interviewSlotOffers.id, of.id));
    expect(o).toMatchObject({ status: "declined", candidateNote: "weekday mornings before 10" });
    const [c] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, call.id));
    expect(c!.details).toMatchObject({ note: "weekday mornings before 10" });
  });

  test("voicemail tries once more, then the e-mail stands; an opt-out is honoured", async () => {
    const a = await liveCall();
    const runA = await newRun();
    await run("end_scheduling_call", { reason: "voicemail" }, runA);
    const [c1] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, a.call.id));
    expect(c1!.status).toBe("no_answer");
    expect(c1!.dueAt).not.toBeNull();

    const b = await liveCall();
    const runB = await newRun();
    await run("end_scheduling_call", { reason: "opt_out" }, runB);
    const [cand] = await db
      .select({ at: candidates.aiCallOptOutAt })
      .from(candidates)
      .where(eq(candidates.id, b.candidateId));
    expect(cand!.at).not.toBeNull();
  });
});

/* ------------------------------------------------ a whole call, fake line */

type VoiceOpts = Parameters<typeof gw.aiVoiceSession>[0];
type Step =
  { say: "ai" | "caller"; text: string } | { tool: string; args: Record<string, unknown> };

class FakeLine implements session.PhoneLine {
  dialled: string | null = null;
  private resolveEnded!: () => void;
  readonly ended = new Promise<void>((r) => (this.resolveEnded = r));
  async dial(number: string) {
    this.dialled = number;
  }
  onAudio() {}
  play() {}
  clear() {}
  pendingSeconds() {
    return 0;
  }
  async hangup() {}
  close() {}
  hangsUp() {
    this.resolveEnded();
  }
}

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
    const play = async () => {
      for (const st of steps) {
        if ("say" in st) {
          const turn = { who: st.say, text: st.text, at: new Date().toISOString() };
          transcript.push(turn);
          opts.events?.onTurn?.(turn);
        } else {
          const out = await opts.events!.onToolCall!({ id: st.tool, name: st.tool, args: st.args });
          seen.results.push({ tool: st.tool, out });
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return {
      ok: true as const,
      session: {
        sendAudio() {},
        sendText(text: string) {
          if (text.includes("picked up")) void play();
        },
        close: async () => {
          const x = summary();
          close(x);
          return x;
        },
        done,
      },
    };
  }) as unknown as typeof gw.aiVoiceSession;
}

const DISCLOSE =
  "This is Saranya, an AI recruiting assistant from Sched Org, about your first-round interview. Do you have a minute to pick a time? I'll note the time you choose for the hiring team.";

describe("a whole scheduling call (fake line)", () => {
  async function arranged(o: { attempt?: number } = {}) {
    const { appId, candidateId } = await candidateApp();
    const of = await offer(appId);
    const [call] = await db
      .insert(screeningCalls)
      .values({
        orgId,
        candidateId,
        applicationId: appId,
        requisitionId: reqId,
        purpose: "scheduling",
        slotOfferId: of.id,
        alternates: [weekday(7)],
        requestedBy: userId,
        status: "dialling",
        attempt: o.attempt ?? 1,
      })
      .returning();
    return { call: call!, offer: of, appId };
  }
  const place = (callId: string, line: FakeLine, voice: typeof gw.aiVoiceSession) =>
    session.runScreeningCall(orgId, callId, {
      line: () => line,
      voice,
      limits: { silenceMs: 60_000, firstWordsMs: 60_000, callerFirstMs: 0 },
    });

  test("the candidate picks the second time: booked, read back, run closed", async () => {
    const { call, offer: of, appId } = await arranged();
    const line = new FakeLine();
    const seen: { opts?: VoiceOpts; results: unknown[] } = { results: [] };
    const r = await place(
      call.id,
      line,
      scriptedVoice(
        [
          { say: "ai", text: "Hello, am I speaking with Meera?" },
          { say: "caller", text: "Yes." },
          // A "yes" before the disclosure is refused.
          { tool: "record_permission", args: { granted: true, their_words: "Yes." } },
          { say: "ai", text: DISCLOSE },
          { say: "caller", text: "Sure, go ahead." },
          { tool: "record_permission", args: { granted: true, their_words: "Sure, go ahead." } },
          { say: "caller", text: "The second one." },
          { tool: "book_interview_time", args: { option: 2 } },
          { say: "ai", text: "Booked. Goodbye." },
          { tool: "end_scheduling_call", args: { reason: "booked" } },
        ],
        seen,
      ),
    );
    expect(line.dialled).toBe("9840012345");
    expect(r).toMatchObject({ status: "completed", endReason: "booked" });
    expect(seen.opts).toMatchObject({ feature: "scheduling_call", languageCode: "en-IN" });
    expect(seen.opts!.tools!.map((t) => t.name).sort()).toEqual([
      "book_interview_time",
      "call_back_later",
      "end_scheduling_call",
      "record_availability",
      "record_permission",
    ]);
    expect(seen.opts!.system).toContain(`2. ${brief.spokenWhen(of.slots[1]!, "Asia/Kolkata")}`);
    const outs = seen.results as { tool: string; out: Record<string, unknown> }[];
    expect(outs[0]!.out).toMatchObject({ ok: false });
    expect(outs.find((x) => x.tool === "book_interview_time")!.out).toMatchObject({
      ok: true,
      booked_for: brief.spokenWhen(of.slots[1]!, "Asia/Kolkata"),
    });
    const [iv] = await db.select().from(interviews).where(eq(interviews.applicationId, appId));
    expect(iv!.scheduledAt.toISOString()).toBe(of.slots[1]);
    const [c] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, call.id));
    expect(c!.transcript.length).toBeGreaterThan(0);
    expect(c!.consentWords).toBe("Sure, go ahead.");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, c!.agentRunId!));
    expect(run).toMatchObject({ agentType: "scheduling_call", status: "done" });
  });

  test("a call-back in ten minutes: saved as the call's next time, once only", async () => {
    const { call } = await arranged();
    const seen: { opts?: VoiceOpts; results: unknown[] } = { results: [] };
    const before = Date.now();
    const r = await place(
      call.id,
      new FakeLine(),
      scriptedVoice(
        [
          { say: "ai", text: DISCLOSE },
          { say: "caller", text: "Okay, what are the times?" },
          { tool: "record_permission", args: { granted: true, their_words: "Okay." } },
          { say: "caller", text: "Call me back in 10 minutes, I need my calendar." },
          { tool: "call_back_later", args: { minutes: 10, their_words: "in 10 minutes" } },
          { tool: "end_scheduling_call", args: { reason: "callback" } },
        ],
        seen,
      ),
    );
    expect(r).toMatchObject({ status: "callback" });
    const back = (seen.results as { tool: string; out: Record<string, unknown> }[]).find(
      (x) => x.tool === "call_back_later",
    )!.out;
    expect(back).toMatchObject({ ok: true, back_at: expect.stringMatching(/ at \d\d:\d\d$/) });
    const [c] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, call.id));
    expect(c).toMatchObject({ status: "callback", reschedules: 1, bookedByCandidate: true });
    const due = c!.dueAt!.getTime();
    expect(due).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);

    // The call-back itself: it says so, and a second call-back is refused.
    await db
      .update(screeningCalls)
      .set({ status: "dialling" })
      .where(eq(screeningCalls.id, call.id));
    const again: { opts?: VoiceOpts; results: unknown[] } = { results: [] };
    await place(
      call.id,
      new FakeLine(),
      scriptedVoice(
        [
          { say: "ai", text: DISCLOSE },
          { tool: "record_permission", args: { granted: true, their_words: "Yes." } },
          { tool: "call_back_later", args: { minutes: 10, their_words: "again" } },
          { tool: "end_scheduling_call", args: { reason: "not_now" } },
        ],
        again,
      ),
    );
    expect(again.opts!.system).toContain("you asked me to call you back");
    expect(
      (again.results as { tool: string; out: Record<string, unknown> }[]).find(
        (x) => x.tool === "call_back_later",
      )!.out,
    ).toMatchObject({ ok: false });
  });

  test("voicemail: tried once more, then the e-mailed link stands", async () => {
    const steps: Step[] = [
      { say: "ai", text: "The talent acquisition team will try again later. Goodbye." },
      { tool: "end_scheduling_call", args: { reason: "voicemail" } },
    ];
    const first = await arranged();
    expect(
      await place(first.call.id, new FakeLine(), scriptedVoice(steps, { results: [] })),
    ).toMatchObject({ status: "no_answer" });
    const [c1] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, first.call.id));
    expect(c1!.dueAt).not.toBeNull();
    expect(c1!.transcript).toEqual([]); // nothing kept without their go-ahead
    const second = await arranged({ attempt: 2 });
    expect(
      await place(second.call.id, new FakeLine(), scriptedVoice(steps, { results: [] })),
    ).toMatchObject({ status: "fell_back" });
  });

  test("picked by the link before the call: nobody is dialled", async () => {
    const { call, offer: of } = await arranged();
    await db
      .update(interviewSlotOffers)
      .set({ status: "booked" })
      .where(eq(interviewSlotOffers.id, of.id));
    const line = new FakeLine();
    expect(await place(call.id, line, scriptedVoice([], { results: [] }))).toMatchObject({
      status: "fell_back",
      endReason: "already_chosen",
    });
    expect(line.dialled).toBeNull();
  });

  test("the dispatcher dials scheduling calls only while switched on, at most twice", async () => {
    const { call } = await arranged();
    const monday11 = (() => {
      const d = new Date(weekday(1));
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      return d; // a Monday, 11:00 IST: inside the default window
    })();
    await db
      .update(screeningCalls)
      .set({ status: "approved", attempt: 0, dueAt: new Date(monday11.getTime() - 60_000) })
      .where(eq(screeningCalls.id, call.id));
    await settings.setPhoneScreeningPolicyCore(
      orgId,
      { userId, memberEmail: interviewer },
      { ...settings.DEFAULT_PHONE_SCREENING_POLICY, enabled: true, schedulingEnabled: false },
    );
    expect((await dispatcher.dueCalls(monday11)).map((r) => r.id)).not.toContain(call.id);
    await settings.setPhoneScreeningPolicyCore(
      orgId,
      { userId, memberEmail: interviewer },
      { ...settings.DEFAULT_PHONE_SCREENING_POLICY, enabled: true, schedulingEnabled: true },
    );
    expect((await dispatcher.dueCalls(monday11)).map((r) => r.id)).toContain(call.id);
    await db
      .update(screeningCalls)
      .set({ status: "no_answer", attempt: 2 })
      .where(eq(screeningCalls.id, call.id));
    expect((await dispatcher.dueCalls(monday11)).map((r) => r.id)).not.toContain(call.id);
  });
});

describe("who speaks first", () => {
  const watch = (heard: () => boolean, aiSpoke: () => boolean, callerFirstMs: number) => {
    const sent: string[] = [];
    const stop = session.openingWatch({
      session: { sendText: (t) => sent.push(t) },
      heard,
      aiSpoke,
      callerFirstMs,
      tag: "test",
      callId: "t",
    });
    return { sent, stop };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("the candidate says hello: no cue, and the assistant answers them", async () => {
    let ai = false;
    const w = watch(
      () => true,
      () => ai,
      300,
    );
    await wait(500);
    ai = true; // the model replied to their hello on its own
    await wait(200);
    w.stop();
    expect(w.sent).toEqual([]);
  });

  test("they stay quiet: the assistant greets them after the wait", async () => {
    let ai = false;
    const w = watch(
      () => false,
      () => ai,
      200,
    );
    await wait(100);
    expect(w.sent).toEqual([]); // still waiting for their hello
    await wait(300);
    ai = true;
    await wait(150);
    w.stop();
    expect(w.sent).toEqual([
      "(The person picked up but has not said anything yet. Greet them now.)",
    ]);
  });

  test("they said hello but the assistant stays silent: one nudge", async () => {
    const w = watch(
      () => true,
      () => false,
      60_000,
    );
    await wait(3_400);
    w.stop();
    expect(w.sent).toEqual(["(The person has answered the phone. Reply to them now.)"]);
  });
});
