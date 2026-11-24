/**
 * Voice confirmation and reminder calls (migration 0092), against the
 * disposable database:
 *  - the in-call tools' rules (pure): the go-ahead after the disclosure, only
 *    clear answers, panel times by number only, outcomes;
 *  - when each call is arranged — and every reason it is not;
 *  - answers go through the confirm link's own core (a no reaches the desk);
 *  - one reminder scheduling call for unanswered e-mailed times;
 *  - the dispatcher: a panel call follows the panelist's opt-out, not the candidate's;
 *  - a whole confirmation call and a whole panel time check on a fake line.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/confirm-calls.test.ts
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
  agentPolicies,
  agentRuns,
  applications,
  candidates,
  interviewConfirmations,
  interviewSlotOffers,
  interviews,
  orgMembers,
  organizations,
  panelists,
  requisitions,
  screeningCalls,
  users,
} = await import("../drizzle/schema");
const tools = await import("../src/server/voice/confirm-call-tools");
const prompts = await import("../src/server/voice/confirm-call-prompts");
const calls = await import("../src/server/voice/confirm-calls.server");
const request = await import("../src/server/voice/scheduling-request.server");
const settings = await import("../src/server/voice/settings.server");
const confirmations = await import("../src/lib/interview-confirmations.server");
const gw = await import("../src/lib/ai-gateway.server");
const session = await import("../src/server/voice/call-session.server");
const dispatcher = await import("../src/server/voice/dispatcher.server");

const stamp = Date.now();
const H = 3600_000;
const ALL_HOURS = {
  ...settings.DEFAULT_PHONE_SCREENING_POLICY,
  windowStartMinute: 0,
  windowEndMinute: 1440,
  callDays: [1, 2, 3, 4, 5, 6, 7],
};
const owner = `cfm-${stamp}@test.local`;
let orgId: string;
let userId: string;
let reqId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (await db.insert(users).values({ email: owner }).returning({ id: users.id }))[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Cfm Org", slug: `cfm-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: owner,
    fullName: "Priya Natarajan",
    status: "active",
    isOwner: true,
  } as never);
  reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-CF-${stamp}`,
        title: "Platform SRE",
        status: "approved",
        createdBy: userId,
      })
      .returning({ id: requisitions.id })
  )[0]!.id;
  await gw.writeProviderKey(orgId, "google", "test-api-key-not-real");
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await settings.setPhoneScreeningPolicyCore(
    orgId,
    { userId, memberEmail: owner },
    { ...ALL_HOURS, enabled: true, schedulingEnabled: true },
  );
  for (const agentType of ["confirmation_call", "panel_check_call"] as const)
    await db
      .insert(agentPolicies)
      .values({ orgId, agentType, enabled: true, autonomy: "act_and_notify" })
      .onConflictDoUpdate({
        target: [agentPolicies.orgId, agentPolicies.agentType],
        set: { enabled: true },
      });
});

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

/** A booked round `inHours` away with the candidate's answer `state`. */
async function bookedRound(inHours: number, state: "pending" | "accepted" = "pending") {
  const { appId, candidateId } = await candidateApp();
  const at = new Date(Date.now() + inHours * H);
  const [iv] = await db
    .insert(interviews)
    .values({
      orgId,
      applicationId: appId,
      level: 2,
      interviewer: "Sivakami",
      interviewerEmail: `siva-${stamp}@test.local`,
      scheduledAt: at,
      teamsLink: "https://teams.example/meet",
      status: "scheduled",
    })
    .returning({ id: interviews.id });
  await confirmations.candidateConfirmation(
    orgId,
    iv!.id,
    at,
    { name: "Meera Krishnan", email: "meera@cand.local" },
    state,
  );
  const [row] = await db
    .select()
    .from(interviewConfirmations)
    .where(eq(interviewConfirmations.interviewId, iv!.id));
  return { appId, candidateId, interviewId: iv!.id, row: row!, at };
}

const confirmationCallFor = async (confirmationId: string) =>
  db.select().from(screeningCalls).where(eq(screeningCalls.confirmationId, confirmationId));

/* ------------------------------------------------------------ pure rules */

describe("the in-call tools", () => {
  test("confirmation: go-ahead only after the disclosure; then one clear answer", () => {
    const s = tools.freshConfirmationState();
    expect(tools.applyConfirmationTool(s, "will_attend", { their_words: "yes" })).toMatchObject({
      ok: false,
    });
    expect(
      tools.applyConfirmationTool(
        s,
        "record_attendance_go_ahead",
        { granted: true, their_words: "Sure" },
        "Hello, am I speaking with Meera?",
        "Sure",
      ),
    ).toMatchObject({ ok: false });
    expect(
      tools.applyConfirmationTool(
        s,
        "record_attendance_go_ahead",
        { granted: true, their_words: "Sure" },
        "I'm an AI assistant; I'll note this call and it is checked for quality. Do you have a moment?",
        "Sure",
      ),
    ).toMatchObject({ ok: true });
    expect(
      tools.applyConfirmationTool(s, "will_attend", { their_words: "Yes I will" }),
    ).toMatchObject({ ok: true, answer: { attend: true } });
    expect(tools.applyConfirmationTool(s, "cannot_attend", { their_words: "no" })).toMatchObject({
      ok: false,
    });
    expect(tools.confirmationOutcome(s)).toBe("confirmed");
  });

  test("an unclear no is sent back once; outcomes", () => {
    const s = tools.freshConfirmationState();
    expect(
      tools.applyConfirmationTool(s, "record_attendance_go_ahead", {
        granted: false,
        their_words: "what is this about?",
      }),
    ).toMatchObject({ ok: false });
    expect(
      tools.applyConfirmationTool(s, "record_attendance_go_ahead", {
        granted: false,
        their_words: "what is this about?",
      }),
    ).toMatchObject({ ok: true });
    expect(tools.confirmationOutcome(s)).toBe("not_now");
    expect(
      tools.confirmationOutcome({ permission: null, answer: null, endReason: "opt_out" }),
    ).toBe("opt_out");
    expect(tools.confirmationOutcome({ permission: null, answer: null, endReason: null })).toBe(
      "no_answer",
    );
  });

  test("panel: times by number only, none is an answer too", () => {
    const times = ["2026-12-01T05:30:00.000Z", "2026-12-02T05:30:00.000Z"];
    const s = { ...tools.freshPanelCheckState(), permission: true };
    expect(
      tools.applyPanelTool(s, "answer_times", { can_do: [3], their_words: "the third" }, times),
    ).toMatchObject({ ok: false });
    expect(
      tools.applyPanelTool(s, "answer_times", { can_do: [2, 2], their_words: "second" }, times),
    ).toMatchObject({ ok: true, answer: { canDo: [times[1]] } });
    expect(tools.panelCheckOutcome(s)).toBe("answered");
    const none = { ...tools.freshPanelCheckState(), permission: true };
    expect(
      tools.applyPanelTool(none, "answer_times", { can_do: [], their_words: "none" }, times),
    ).toMatchObject({ ok: true, answer: { canDo: [] } });
  });

  test("the prompts carry the facts and never a staff name", () => {
    const p = prompts.confirmationSystemPrompt({
      assistantName: "Saranya",
      orgName: "Yavar",
      candidateFirstName: "Vishal",
      roleTitle: "AI Intern",
      roundLabel: "second-round interview",
      when: "Tuesday 24 November at 13:00",
      durationMins: 60,
      format: "online (video call)",
      joinHow: "the meeting link in the invite e-mail",
      panelSize: 1,
      maxMinutes: 3,
    });
    expect(p).toContain("Tuesday 24 November at 13:00");
    expect(p).toContain("with the hiring team");
    expect(p).not.toContain("Sivakami");
    const q = prompts.panelSystemPrompt({
      assistantName: "Saranya",
      orgName: "Yavar",
      panelistFirstName: "Sivakami",
      candidateName: "Vishal L V",
      roleTitle: "AI Intern",
      roundLabel: "L2 interview",
      durationMins: 60,
      format: "online (video call)",
      times: ["Tuesday 24 November at 13:00", "Wednesday 25 November at 11:00"],
      booked: false,
      maxMinutes: 3,
    });
    expect(q).toContain("1. Tuesday 24 November at 13:00");
    expect(q).toContain("Which of these can you do?");
  });
});

/* ------------------------------------------------------------ arranging */

describe("attendance confirmation calls are arranged", () => {
  test("for a pending booked round within a day; once", async () => {
    const r = await bookedRound(20);
    await calls.requestConfirmationCalls(orgId);
    const [c] = await confirmationCallFor(r.row.id);
    expect(c).toMatchObject({ purpose: "confirmation", status: "approved", requestedBy: userId });
    await calls.requestConfirmationCalls(orgId);
    expect(await confirmationCallFor(r.row.id)).toHaveLength(1);
  });

  test("never when confirmed, too far, too close, opted out, no mobile or switched off", async () => {
    const confirmed = await bookedRound(20, "accepted");
    const far = await bookedRound(40);
    const close = await bookedRound(2);
    const optedOut = await bookedRound(20);
    await db
      .update(candidates)
      .set({ aiCallOptOutAt: new Date() })
      .where(eq(candidates.id, optedOut.candidateId));
    const noPhone = await bookedRound(20);
    await db.update(candidates).set({ phone: null }).where(eq(candidates.id, noPhone.candidateId));
    await calls.requestConfirmationCalls(orgId);
    for (const r of [confirmed, far, close, optedOut, noPhone])
      expect(await confirmationCallFor(r.row.id)).toHaveLength(0);

    const off = await bookedRound(20);
    await db
      .update(agentPolicies)
      .set({ enabled: false })
      .where(and(eq(agentPolicies.orgId, orgId), eq(agentPolicies.agentType, "confirmation_call")));
    await calls.requestConfirmationCalls(orgId);
    expect(await confirmationCallFor(off.row.id)).toHaveLength(0);
  });
});

describe("answers go through the confirm link", () => {
  test("a yes confirms the round; a no is declined with their words", async () => {
    const yes = await bookedRound(20);
    expect(await calls.answerAttendance(yes.row, true, "I'll be there")).toEqual({ ok: true });
    const [y] = await db
      .select()
      .from(interviewConfirmations)
      .where(eq(interviewConfirmations.id, yes.row.id));
    expect(y!.state).toBe("accepted");

    const no = await bookedRound(20);
    expect(await calls.answerAttendance(no.row, false, "family function")).toEqual({ ok: true });
    const [n] = await db
      .select()
      .from(interviewConfirmations)
      .where(eq(interviewConfirmations.id, no.row.id));
    expect(n).toMatchObject({ state: "declined" });
    expect(n!.note).toContain("family function");
    // Answered once only.
    expect(await calls.answerAttendance(no.row, true, "actually yes")).toMatchObject({ ok: false });
  });
});

/* ------------------------------------------------------------ panel calls */

async function panelistWaiting(o: { phone?: string | null; ageMins?: number } = {}) {
  const { appId } = await candidateApp();
  const slots = [new Date(Date.now() + 30 * H), new Date(Date.now() + 54 * H)].map((d) =>
    d.toISOString(),
  );
  const [of] = await db
    .insert(interviewSlotOffers)
    .values({
      orgId,
      applicationId: appId,
      level: 1,
      interviewerName: "Sivakami",
      interviewerEmail: `siva-${stamp}@test.local`,
      slots,
      token: `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      status: "offered",
      expiresAt: new Date(Date.now() + 3 * 864e5),
    })
    .returning();
  const email = `pan-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const [p] = await db
    .insert(panelists)
    .values({
      orgId,
      kind: "internal",
      fullName: "Sivakami K",
      email,
      phone: o.phone === undefined ? "+91 98400 54321" : o.phone,
    })
    .returning();
  const [row] = await db
    .insert(interviewConfirmations)
    .values({
      orgId,
      offerId: of!.id,
      party: "panelist",
      email,
      name: "Sivakami K",
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""),
      state: "pending",
      createdAt: new Date(Date.now() - (o.ageMins ?? 70) * 60_000),
    })
    .returning();
  return { appId, offer: of!, panelist: p!, row: row!, slots };
}

describe("panel time checks are arranged", () => {
  test("after the reminder point, with a mobile; once", async () => {
    const w = await panelistWaiting();
    await calls.requestPanelCheckCalls(orgId);
    const [c] = await confirmationCallFor(w.row.id);
    expect(c).toMatchObject({ purpose: "panel_check", panelistId: w.panelist.id });
    await calls.requestPanelCheckCalls(orgId);
    expect(await confirmationCallFor(w.row.id)).toHaveLength(1);
  });

  test("never too early, without a mobile, or after the panelist opted out", async () => {
    const early = await panelistWaiting({ ageMins: 20 });
    const noPhone = await panelistWaiting({ phone: null });
    const out = await panelistWaiting();
    await db
      .update(panelists)
      .set({ aiCallOptOutAt: new Date() })
      .where(eq(panelists.id, out.panelist.id));
    await calls.requestPanelCheckCalls(orgId);
    for (const r of [early, noPhone, out])
      expect(await confirmationCallFor(r.row.id)).toHaveLength(0);
  });

  test("the dispatcher follows the panelist's opt-out, not the candidate's", async () => {
    const w = await panelistWaiting();
    await calls.requestPanelCheckCalls(orgId);
    const [c] = await confirmationCallFor(w.row.id);
    await db
      .update(screeningCalls)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(screeningCalls.id, c!.id));
    await db
      .update(candidates)
      .set({ aiCallOptOutAt: new Date() })
      .where(eq(candidates.id, c!.candidateId));
    const due = async () =>
      ((await dispatcher.dueCalls(new Date(), 500)) as unknown as { id: string }[]).some(
        (x) => x.id === c!.id,
      );
    expect(await due()).toBe(true);
    await db
      .update(panelists)
      .set({ aiCallOptOutAt: new Date() })
      .where(eq(panelists.id, w.panelist.id));
    expect(await due()).toBe(false);
  });
});

/* ------------------------------------------------------------ reminder scheduling call */

describe("a reminder call for unanswered e-mailed times", () => {
  test("one per offer, even after the assistant spoke about the round", async () => {
    const { appId, candidateId } = await candidateApp();
    const slots = [new Date(Date.now() + 30 * H), new Date(Date.now() + 54 * H)].map((d) =>
      d.toISOString(),
    );
    const [of] = await db
      .insert(interviewSlotOffers)
      .values({
        orgId,
        applicationId: appId,
        level: 1,
        interviewerName: "Sivakami",
        interviewerEmail: `siva-${stamp}@test.local`,
        slots,
        token: `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
        status: "offered",
        expiresAt: new Date(Date.now() + 20 * H),
        linkEmailedAt: new Date(Date.now() - 4 * H),
        createdBy: userId,
      })
      .returning();
    // The first call reached them (they agreed, then said not now).
    await db.insert(screeningCalls).values({
      orgId,
      candidateId,
      applicationId: appId,
      requisitionId: reqId,
      purpose: "scheduling",
      slotOfferId: of!.id,
      status: "completed",
      endReason: "not_now",
      consentAt: new Date(Date.now() - 5 * H),
    });
    expect((await request.checkSchedulingCall(orgId, appId)).ok).toBe(false);
    expect(await request.remindUnansweredOffers(orgId)).toBe(1);
    const rows = await db
      .select()
      .from(screeningCalls)
      .where(and(eq(screeningCalls.slotOfferId, of!.id), eq(screeningCalls.reminder, true)));
    expect(rows).toHaveLength(1);
    expect(await request.remindUnansweredOffers(orgId)).toBe(0);
  });
});

/* ------------------------------------------------------------ whole calls */

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
    let started = false;
    const play = async () => {
      if (started) return;
      started = true;
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
          if (text.includes("phone is ringing")) {
            setTimeout(() => void play(), 20);
            return;
          }
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
  "Thank you. I'm an AI recruiting assistant; I'll note this short call for the hiring team, and it is checked for quality. Do you have a moment?";
const LIMITS = { silenceMs: 60_000, firstWordsMs: 60_000, callerFirstMs: 0 };

describe("whole calls (fake line)", () => {
  test("the candidate confirms tomorrow's round: accepted, run closed", async () => {
    const r = await bookedRound(20);
    const [call] = await db
      .insert(screeningCalls)
      .values({
        orgId,
        candidateId: r.candidateId,
        applicationId: r.appId,
        requisitionId: reqId,
        purpose: "confirmation",
        confirmationId: r.row.id,
        requestedBy: userId,
        status: "dialling",
        attempt: 1,
      })
      .returning();
    const line = new FakeLine();
    const seen: { opts?: VoiceOpts; results: unknown[] } = { results: [] };
    const res = await session.runScreeningCall(orgId, call!.id, {
      line: () => line,
      voice: scriptedVoice(
        [
          { say: "ai", text: "Hello, am I speaking with Meera?" },
          { say: "caller", text: "Yes." },
          { say: "ai", text: DISCLOSE },
          { say: "caller", text: "Sure." },
          { tool: "record_attendance_go_ahead", args: { granted: true, their_words: "Sure." } },
          { say: "ai", text: "Will you be able to attend?" },
          { say: "caller", text: "Yes, I'll be there." },
          { tool: "will_attend", args: { their_words: "Yes, I'll be there." } },
          { say: "ai", text: "Confirmed. Goodbye." },
          { tool: "end_confirmation_call", args: { reason: "confirmed" } },
        ],
        seen,
      ),
      limits: LIMITS,
    });
    expect(line.dialled).toBe("9840012345");
    expect(res).toMatchObject({ status: "completed", endReason: "confirmed" });
    expect(seen.opts).toMatchObject({ feature: "confirmation_call", languageCode: "en-IN" });
    expect(seen.opts!.tools!.map((t) => t.name).sort()).toEqual([
      "cannot_attend",
      "end_confirmation_call",
      "record_attendance_go_ahead",
      "will_attend",
    ]);
    const [k] = await db
      .select()
      .from(interviewConfirmations)
      .where(eq(interviewConfirmations.id, r.row.id));
    expect(k!.state).toBe("accepted");
    const [c] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, call!.id));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, c!.agentRunId!));
    expect(run).toMatchObject({ agentType: "confirmation_call", status: "done" });
  });

  test("nobody answers twice: the call gives up (the desk is asked to phone)", async () => {
    const r = await bookedRound(20);
    const [call] = await db
      .insert(screeningCalls)
      .values({
        orgId,
        candidateId: r.candidateId,
        applicationId: r.appId,
        requisitionId: reqId,
        purpose: "confirmation",
        confirmationId: r.row.id,
        requestedBy: userId,
        status: "dialling",
        attempt: 2,
      })
      .returning();
    const line = new FakeLine();
    line.dial = async () => {
      throw new Error("486 busy");
    };
    const res = await session.runScreeningCall(orgId, call!.id, {
      line: () => line,
      voice: scriptedVoice([], { results: [] }),
      limits: LIMITS,
    });
    expect(res).toMatchObject({ status: "fell_back", endReason: "no_answer" });
  });

  test("the panelist says which offered times work: their answer is recorded", async () => {
    const w = await panelistWaiting();
    const [call] = await db
      .insert(screeningCalls)
      .values({
        orgId,
        candidateId: (
          await db
            .select({ id: applications.candidateId })
            .from(applications)
            .where(eq(applications.id, w.appId))
        )[0]!.id,
        applicationId: w.appId,
        requisitionId: reqId,
        purpose: "panel_check",
        confirmationId: w.row.id,
        panelistId: w.panelist.id,
        requestedBy: userId,
        status: "dialling",
        attempt: 1,
      })
      .returning();
    const line = new FakeLine();
    const res = await session.runScreeningCall(orgId, call!.id, {
      line: () => line,
      voice: scriptedVoice(
        [
          { say: "ai", text: "Hello, am I speaking with Sivakami?" },
          { say: "caller", text: "Yes." },
          { say: "ai", text: DISCLOSE },
          { say: "caller", text: "Go ahead." },
          { tool: "record_panel_go_ahead", args: { granted: true, their_words: "Go ahead." } },
          { say: "caller", text: "Only the second one." },
          { tool: "answer_times", args: { can_do: [2], their_words: "Only the second one." } },
          { say: "ai", text: "Noted. Goodbye." },
          { tool: "end_panel_call", args: { reason: "answered" } },
        ],
        { results: [] },
      ),
      limits: LIMITS,
    });
    expect(line.dialled).toBe("9840054321");
    expect(res).toMatchObject({ status: "completed", endReason: "answered" });
    const [k] = await db
      .select()
      .from(interviewConfirmations)
      .where(eq(interviewConfirmations.id, w.row.id));
    expect(k).toMatchObject({ state: "accepted", okSlots: [w.slots[1]] });
  });
});
