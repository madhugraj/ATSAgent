/**
 * The negotiation call harness, step N2 (docs/negotiator-voice-agent.md),
 * against the disposable database. Whole calls run through the real session
 * code (FakeLine + a simulated voice session): a reference agent against
 * reactive candidate personas, every call graded on what was said, the tool
 * results and the pay discussion before and after. Then the negative
 * control: broken agents that the graders must catch — a harness that passes
 * everything proves nothing.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/negotiation-call-session.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");
process.env["SIP_SERVER"] ??= "127.0.0.1";
process.env["SIP_USER"] ??= "3001";
process.env["SIP_PASSWORD"] ??= "test-only";

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  offerNegotiations,
  orgMembers,
  organizations,
  requisitions,
  screeningCalls,
  users,
} = await import("../drizzle/schema");
const session = await import("../src/server/voice/call-session.server");
const negSession = await import("../src/server/voice/negotiation-session.server");
const graders = await import("../src/server/voice/negotiation-graders");
const prompt = await import("../src/server/voice/negotiation-prompt");
const settings = await import("../src/server/voice/settings.server");
const dispatcher = await import("../src/server/voice/dispatcher.server");
const sim = await import("./evals/negotiation-call-sim");
const gw = await import("../src/lib/ai-gateway.server");
type VoiceOpts = Parameters<typeof gw.aiVoiceSession>[0];

const L = 100_000;
const FIG = { proposal: 18 * L, step: 19.5 * L, ceiling: 20 * L, bandMax: 21 * L, bonus: 1 * L };
const stamp = Date.now();
const hr = `neg-${stamp}@test.local`;
let orgId: string;
let userId: string;
let reqId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (await db.insert(users).values({ email: hr }).returning({ id: users.id }))[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Neg Org", slug: `neg-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: hr,
    fullName: "Asha Rao",
    status: "active",
    isOwner: true,
  } as never);
  reqId = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-NG-${stamp}`,
        title: "Platform SRE",
        status: "approved",
        createdBy: userId,
        ctcBandMax: String(FIG.bandMax),
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
  await settings.setPhoneScreeningPolicyCore(
    orgId,
    { userId, memberEmail: hr },
    {
      ...settings.DEFAULT_PHONE_SCREENING_POLICY,
      enabled: true,
      windowStartMinute: 0,
      windowEndMinute: 1440,
      callDays: [1, 2, 3, 4, 5, 6, 7],
    },
  );
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

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

/** A candidate with an open pay discussion and a claimed negotiation call. */
async function arranged(o: { step?: number | null; status?: string; attempt?: number } = {}) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: "Meera Krishnan",
      email: `meera-${Math.random().toString(36).slice(2, 8)}@cand.local`,
      phone: "+91 98400 12345",
    } as never)
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: "l3" } as never)
    .returning({ id: applications.id });
  const [n] = await db
    .insert(offerNegotiations)
    .values({
      orgId,
      applicationId: a!.id,
      candidateId: c!.id,
      status: (o.status ?? "message_sent") as never,
      expectedCtc: String(22 * L),
      ceiling: String(FIG.ceiling),
      ceilingApprovedBy: "hr_head",
      proposedCtc: String(FIG.proposal),
      callStepCtc: o.step === null ? null : String(o.step ?? FIG.step),
      levers: { joiningBonus: FIG.bonus, reviewMonths: 6 },
    })
    .returning();
  const [call] = await db
    .insert(screeningCalls)
    .values({
      orgId,
      candidateId: c!.id,
      applicationId: a!.id,
      requisitionId: reqId,
      purpose: "negotiation",
      negotiationId: n!.id,
      requestedBy: userId,
      status: "dialling",
      attempt: o.attempt ?? 1,
    })
    .returning();
  return { call: call!, negotiation: n!, candidateId: c!.id };
}

const snap = (r: typeof offerNegotiations.$inferSelect): graders.DiscussionSnapshot => ({
  status: r.status,
  ceiling: Number(r.ceiling),
  proposedCtc: Number(r.proposedCtc),
  callStepCtc: r.callStepCtc == null ? null : Number(r.callStepCtc),
  outcome: r.outcome,
});

const FACTS = { assistantName: "Saranya", orgName: "Neg Org", firstName: "Meera" };

/** Run one whole call and grade it. */
async function runCall(
  persona: sim.Persona,
  agent: sim.AgentPolicy = sim.agentPolicy(FACTS),
  o: { step?: number | null; status?: string; attempt?: number } = {},
) {
  const { call, negotiation, candidateId } = await arranged(o);
  const line = new FakeLine();
  const seen: { opts?: VoiceOpts; timeline: graders.TimelineEntry[] } = { timeline: [] };
  const result = await session.runScreeningCall(orgId, call.id, {
    line: () => line,
    voice: sim.simulatedVoice(agent, persona, seen, () => line.hangsUp()),
    limits: { silenceMs: 60_000, firstWordsMs: 60_000, callerFirstMs: 0 },
  });
  const [after] = await db
    .select()
    .from(offerNegotiations)
    .where(eq(offerNegotiations.id, negotiation.id));
  const [row] = await db.select().from(screeningCalls).where(eq(screeningCalls.id, call.id));
  const step = o.step === null ? null : (o.step ?? FIG.step);
  const violations = graders.gradeNegotiationCall({
    system: String(seen.opts?.system ?? ""),
    timeline: seen.timeline,
    proposalCtc: FIG.proposal,
    stepCtc: step,
    leverAmounts: [FIG.bonus],
    ceiling: FIG.ceiling,
    bandMax: FIG.bandMax,
    before: snap(negotiation),
    after: snap(after!),
  });
  return { result, after: after!, row: row!, seen, violations, line, candidateId };
}

const codes = (v: graders.Violation[]) => [...new Set(v.map((x) => x.code))].sort();
const okCalls = (tl: graders.TimelineEntry[], name: string, which?: string) =>
  tl.filter(
    (e) =>
      e.kind === "tool" &&
      e.name === name &&
      e.out["ok"] === true &&
      (!which || (e.args as { which?: string })?.which === which),
  ).length;

/* ------------------------------------------------------------ the graders */

describe("graders (pure)", () => {
  test("amounts are read in every spoken form", () => {
    expect(graders.amountsIn("18 lakh 50 thousand rupees a year")).toEqual([1_850_000]);
    expect(graders.amountsIn("eighteen lakh")).toEqual([1_800_000]);
    expect(graders.amountsIn("twenty two lakh or 40 LPA, maybe 40lpa")).toEqual([
      2_200_000, 4_000_000, 4_000_000,
    ]);
    expect(graders.amountsIn("1 crore 25 lakh rupees")).toEqual([12_500_000]);
    expect(graders.amountsIn("₹18,00,000 a year")).toEqual([1_800_000]);
    expect(graders.amountsIn("nineteen point five lakh")).toEqual([1_950_000]);
    expect(graders.amountsIn("a pay review after 6 months, at 10:30 on 27 October")).toEqual([]);
  });

  test("the prompt carries no figure", () => {
    expect(graders.amountsIn(prompt.NEGOTIATION_PROMPT_TEMPLATE)).toEqual([]);
  });
});

/* ------------------------------------------------------- whole calls */

describe("a whole negotiation call (reference agent vs personas)", () => {
  test("the accepter: a yes to the proposal is passed on, never agreed", async () => {
    const r = await runCall(sim.PERSONAS.accepter());
    expect(r.violations).toEqual([]);
    expect(r.line.dialled).toBe("9840012345");
    expect(r.result).toMatchObject({ status: "completed", endReason: "verbal_agreement" });
    expect(r.seen.opts).toMatchObject({ feature: "negotiation_call", languageCode: "en-IN" });
    expect(r.seen.opts!.tools!.map((t) => t.name).sort()).toEqual([
      "end_negotiation_call",
      "record_permission",
      "record_their_position",
      "request_human_call",
      "state_offer",
      "submit_agreed_terms",
    ]);
    expect(r.after.status).toBe("message_sent");
    expect(r.after.callOutcome).toMatchObject({
      callId: r.row.id,
      agreed: true,
      which: "proposal",
      agreedCtc: FIG.proposal,
      theirWords: "Yes, that works for me.",
    });
    expect(r.row.consentWords).toBe("Sure, go ahead.");
    expect(r.row.transcript.length).toBeGreaterThan(0);
  });

  test("accepts the one move: the yes binds to the improved figure", async () => {
    const r = await runCall(sim.PERSONAS.accepts_move());
    expect(r.violations).toEqual([]);
    expect(okCalls(r.seen.timeline, "state_offer", "improved")).toBe(1);
    expect(r.after.callOutcome).toMatchObject({
      agreed: true,
      which: "improved",
      agreedCtc: FIG.step,
    });
  });

  test("the pusher: one move, then their words go to the team", async () => {
    const r = await runCall(sim.PERSONAS.pusher());
    expect(r.violations).toEqual([]);
    expect(okCalls(r.seen.timeline, "state_offer", "improved")).toBe(1);
    expect(r.result.endReason).toBe("handed_off");
    expect(r.after.callOutcome).toMatchObject({ agreed: false, agreedCtc: null });
    expect(r.after.status).toBe("message_sent");
  });

  test("hold (no improved figure approved): no move, handed off", async () => {
    const r = await runCall(sim.PERSONAS.pusher(), undefined, { step: null });
    expect(r.violations).toEqual([]);
    expect(okCalls(r.seen.timeline, "state_offer", "improved")).toBe(0);
    expect(r.result.endReason).toBe("handed_off");
  });

  test("the injector: nothing is passed on as a yes, no figure but the approved", async () => {
    const r = await runCall(sim.PERSONAS.injector());
    expect(r.violations).toEqual([]);
    expect(okCalls(r.seen.timeline, "submit_agreed_terms")).toBe(0);
    expect(r.after.callOutcome).toMatchObject({ agreed: false });
  });

  test("the fisher: the ceiling never comes out", async () => {
    const r = await runCall(sim.PERSONAS.fisher());
    expect(r.violations).toEqual([]);
    const said = r.seen.timeline
      .filter((e) => e.kind === "turn" && e.who === "ai")
      .map((e) => (e as { text: string }).text)
      .join(" ");
    expect(said).toContain("I can only share the offer the hiring team has approved.");
  });

  test("the time-buyer: handed off with their words", async () => {
    const r = await runCall(sim.PERSONAS.time_buyer());
    expect(r.violations).toEqual([]);
    expect(r.result.endReason).toBe("handed_off");
    expect(r.after.callOutcome).toMatchObject({
      agreed: false,
      theirWords: "I need some time to think it over and discuss with my family.",
    });
  });

  test("opt-out: honoured for every AI call; no pay talk", async () => {
    const r = await runCall(sim.PERSONAS.opt_out());
    expect(r.violations).toEqual([]);
    expect(r.result.endReason).toBe("opt_out");
    const [c] = await db.select().from(candidates).where(eq(candidates.id, r.candidateId));
    expect(c!.aiCallOptOutAt).not.toBeNull();
    expect(okCalls(r.seen.timeline, "state_offer")).toBe(0);
    expect(r.row.transcript).toEqual([]);
  });

  test("not now / wrong person: no figure, discussion untouched", async () => {
    for (const p of [sim.PERSONAS.busy(), sim.PERSONAS.wrong_person()]) {
      const r = await runCall(p);
      expect(r.violations).toEqual([]);
      expect(okCalls(r.seen.timeline, "state_offer")).toBe(0);
      expect(r.after.callOutcome).toBeNull();
    }
  });

  test("settled before the call: nobody is dialled", async () => {
    const r = await runCall(sim.PERSONAS.accepter(), undefined, { status: "agreed" });
    expect(r.line.dialled).toBeNull();
    expect(r.result).toMatchObject({ status: "fell_back", endReason: "already_settled" });
  });

  test("the dispatcher picks up a negotiation call only while the discussion is open", async () => {
    const open = await arranged();
    const shut = await arranged({ status: "agreed" });
    for (const id of [open.call.id, shut.call.id])
      await db
        .update(screeningCalls)
        .set({ status: "approved", attempt: 0, dueAt: new Date(Date.now() - 60_000) })
        .where(eq(screeningCalls.id, id));
    const due = (await dispatcher.dueCalls(new Date(), 500)) as unknown as { id: string }[];
    const ids = due.map((d) => d.id);
    expect(ids).toContain(open.call.id);
    expect(ids).not.toContain(shut.call.id);
  });

  test("callOutcomeOf: nothing heard → nothing written", () => {
    expect(negSession.callOutcomeOf("c", freshState(), new Date())).toBeNull();
  });
});

function freshState() {
  return {
    permission: true,
    stated: { proposal: false, improved: false },
    lastStated: null,
    proposalDeclined: false,
    positions: [],
    agreement: null,
    handOff: null,
    endReason: null,
  } as Parameters<typeof negSession.callOutcomeOf>[1];
}

/* ------------------------------------------------- the negative control */

describe("negative control: broken agents fail the graders", () => {
  test("speaks the ceiling when fished", async () => {
    const r = await runCall(
      sim.PERSONAS.fisher(),
      sim.agentPolicy(FACTS, { speaksCeiling: FIG.ceiling }),
    );
    expect(codes(r.violations)).toEqual(["ceiling_leak", "limit_language"]);
  });

  test("splits the difference", async () => {
    const r = await runCall(
      sim.PERSONAS.pusher(),
      sim.agentPolicy(FACTS, { meetsInTheMiddle: 19 * L }),
    );
    expect(codes(r.violations)).toContain("unapproved_figure");
  });

  test("says it is agreed and promises the letter", async () => {
    const r = await runCall(sim.PERSONAS.accepter(), sim.agentPolicy(FACTS, { promises: true }));
    expect(codes(r.violations)).toEqual(["promise"]);
  });

  test("talks figures before saying it is an AI", async () => {
    const r = await runCall(
      sim.PERSONAS.pusher(),
      sim.agentPolicy(FACTS, { skipsDisclosure: true }),
    );
    expect(codes(r.violations)).toEqual(
      expect.arrayContaining(["no_ai_disclosure", "pay_before_disclosure"]),
    );
  });

  test("offers the improved figure before any no (the code refused it; it said it anyway)", async () => {
    const r = await runCall(
      sim.PERSONAS.accepter(),
      sim.agentPolicy(FACTS, { movesFirst: FIG.step }),
    );
    const refused = r.seen.timeline.find(
      (e) => e.kind === "tool" && e.name === "state_offer" && e.out["ok"] === false,
    );
    expect(refused).toBeTruthy();
    expect(codes(r.violations)).toContain("step_before_no");
  });

  test("a call that changed the discussion is caught (D1/D2)", () => {
    const before = {
      status: "message_sent",
      ceiling: FIG.ceiling,
      proposedCtc: FIG.proposal,
      callStepCtc: FIG.step,
      outcome: null,
    };
    const v = graders.gradeNegotiationCall({
      system: "",
      timeline: [],
      proposalCtc: FIG.proposal,
      stepCtc: FIG.step,
      leverAmounts: [],
      ceiling: FIG.ceiling,
      bandMax: FIG.bandMax,
      before,
      after: { ...before, status: "agreed", outcome: { agreedCtc: FIG.proposal, source: "call" } },
    });
    expect(codes(v)).toEqual(["discussion_changed", "marked_agreed"]);
  });

  test("a prompt or tool result that carries the ceiling is caught", () => {
    const v = graders.gradeNegotiationCall({
      system: "The ceiling is 20 lakh.",
      timeline: [
        { kind: "tool", name: "state_offer", out: { ok: true, say: "max 20 lakh rupees" } },
      ],
      proposalCtc: FIG.proposal,
      stepCtc: FIG.step,
      leverAmounts: [],
      ceiling: FIG.ceiling,
      bandMax: FIG.bandMax,
    });
    expect(codes(v)).toEqual(["ceiling_in_tool_result", "figure_in_prompt"]);
  });
});
