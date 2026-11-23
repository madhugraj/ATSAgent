/**
 * Behaviour-locking coverage for the application stage pipeline (Phase 0, task 0.2):
 *
 *  1. lifecycle.canMove — the full transition table (every allowed move, every
 *     forbidden move, legacy stage canonicalisation).
 *  2. moveStageCore — the HR-controlled role gate, the reason requirement and
 *     the "Screening skipped" note behaviour (including the open-call refusal).
 *  3. recordStageTransition — the stage_events trail row, the screening-prep
 *     enqueue on shortlist, the stage emails through the outbox and the
 *     training-data outcome capture.
 *  4. A source grep: no file outside the known-writers list writes
 *     applications.stage. The list is deliberately temporary — Phase 5 of the
 *     refactor shrinks it to empty.
 *
 * Runs against a disposable local database (see db URL check below); cleans up
 * every row it created via org/user cascade deletes in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FLOW, SIDE, canMove } from "../src/lib/lifecycle";
import type { Stage } from "../src/lib/lifecycle";
import type { LifecycleActor } from "../src/lib/requisitions.server";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run against a non-local database host");
  }
});

// ---------------------------------------------------------------------------
// 1. lifecycle.canMove — the transition table
// ---------------------------------------------------------------------------

describe("lifecycle.canMove", () => {
  const ALL: Stage[] = [...FLOW, ...SIDE];

  // Hand-written expectation of the table in src/lib/lifecycle.ts: forward
  // funnel moves plus every side stage; parked stages re-enter the whole
  // funnel; closed stages only re-open through the pool; a joined candidate
  // can only end up a no-show or withdrawn.
  const after = (s: Stage) => [...FLOW.slice(FLOW.indexOf(s) + 1), ...SIDE];
  const REOPEN: Stage[] = ["reserve", "sourced", "shortlisted"];
  const PARKED_REENTRY: Stage[] = [...FLOW, "rejected", "withdrawn"];
  const allowed: Partial<Record<Stage, Stage[]>> = {
    sourced: after("sourced"),
    applied: after("applied"),
    ai_screened: after("ai_screened"),
    shortlisted: after("shortlisted"),
    l1: after("l1"),
    l2: after("l2"),
    l3: after("l3"),
    offer_pending: after("offer_pending"),
    offer_released: after("offer_released"),
    offer_accepted: after("offer_accepted"),
    joined: ["no_show", "withdrawn"],
    on_hold: PARKED_REENTRY,
    reserve: PARKED_REENTRY,
    joining_deferred: PARKED_REENTRY,
    rejected: REOPEN,
    withdrawn: REOPEN,
    offer_declined: REOPEN,
    no_show: REOPEN,
  };

  test("every allowed transition is allowed", () => {
    for (const from of ALL) {
      for (const to of allowed[from]!) {
        expect(canMove(from, to)).toBe(true);
      }
    }
  });

  test("every other transition is forbidden", () => {
    const forbidden: string[] = [];
    for (const from of ALL) {
      for (const to of ALL) {
        if (allowed[from]!.includes(to)) continue;
        if (canMove(from, to)) forbidden.push(`${from}->${to}`);
      }
    }
    expect(forbidden).toEqual([]);
  });

  test("representative forbidden moves, one per rejection path", () => {
    expect(canMove("l2", "l1")).toBe(false); // no skipping back through the funnel
    expect(canMove("offer_accepted", "offer_released")).toBe(false); // no undoing an acceptance
    expect(canMove("joined", "offer_pending")).toBe(false); // joined is terminal-ish
    expect(canMove("joined", "joined")).toBe(false);
    expect(canMove("rejected", "l1")).toBe(false); // closed candidates re-open via the pool
    expect(canMove("on_hold", "on_hold")).toBe(false); // parking is not a no-op move
    expect(canMove("reserve", "reserve")).toBe(false);
    expect(canMove("sourced", "sourced")).toBe(false);
    expect(canMove("offer_declined", "l3")).toBe(false);
    expect(canMove("withdrawn", "joined")).toBe(false);
    expect(canMove("no_show", "offer_released")).toBe(false);
  });

  test("legacy stages canonicalise before the table is consulted", () => {
    expect(canMove("offer", "joined")).toBe(true); // offer → offer_pending
    expect(canMove("offer_accepted", "hired")).toBe(true); // hired → joined
    expect(canMove("joined", "hired")).toBe(false);
    expect(canMove("rejected", "hired")).toBe(false);
    expect(canMove("offer", "sourced")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const { db } = await import("../src/server/db");
const schema = await import("../drizzle/schema");
const {
  agentEvents,
  applications,
  candidates,
  emailOutbox,
  orgMembers,
  organizations,
  requisitions,
  screeningCalls,
  screeningPrepJobs,
  stageEvents,
  trainingFeedback,
  trainingSettings,
  userRoles,
  users,
} = schema;
const { moveStageCore } = await import("../src/lib/pipeline.server");
const { recordStageTransition } = await import("../src/lib/stage-events.server");
const { resetCaptureCache } = await import("../src/server/training/capture.server");

let orgId: string;
let reqId: string;
let owner: string;
let recruiter: string;
let hrHead: string;
let seq = 0;

async function seedUser(email: string, role?: string) {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  await db.insert(orgMembers).values({
    orgId,
    userId: u!.id,
    email,
    fullName: email.split("@")[0],
    status: "active",
    isOwner: role === "owner",
    joinedAt: new Date(),
  });
  if (role && role !== "owner") {
    await db.insert(userRoles).values({ userId: u!.id, orgId, role: role as never });
  }
  return u!.id;
}

/** One candidate + application per call, each with a unique contact email. */
async function application(stage: string, email?: string | null) {
  const n = ++seq;
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: `Candidate ${n}`,
      // An empty string is the real "no email" shape (the column is not null).
      email: email === null ? "" : (email ?? `cand-${n}-${stamp}@cand.local`),
    })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: reqId, candidateId: c!.id, stage: stage as never })
    .returning({ id: applications.id });
  return { appId: a!.id, candidateId: c!.id };
}

const stageEventsOf = (appId: string) =>
  db
    .select()
    .from(stageEvents)
    .where(eq(stageEvents.applicationId, appId))
    .orderBy(stageEvents.createdAt);

const stageEmailsOf = (appId: string) =>
  db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.orgId, orgId), eq(emailOutbox.applicationId, appId)));

const outcomeFeedbackOf = (appId: string) =>
  db
    .select()
    .from(trainingFeedback)
    .where(
      and(
        eq(trainingFeedback.orgId, orgId),
        eq(trainingFeedback.source, "outcome"),
        eq(trainingFeedback.applicationId, appId),
      ),
    );

beforeAll(async () => {
  const [o] = await db
    .insert(organizations)
    .values({ name: "Pipeline Org", slug: `pipe-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [r] = await db
    .insert(requisitions)
    .values({ orgId, code: `PIPE-${stamp}`, title: "Pipeline Engineer", status: "approved" })
    .returning({ id: requisitions.id });
  reqId = r!.id;
  owner = await seedUser(`pipe-owner-${stamp}@test.local`, "owner");
  recruiter = await seedUser(`pipe-recruiter-${stamp}@test.local`, "recruiter");
  hrHead = await seedUser(`pipe-hr-${stamp}@test.local`, "hr_head");
  // Outcome capture on, so the training-data hook is observable below.
  await db.insert(trainingSettings).values({ orgId, enabled: true, consentedBy: owner });
  resetCaptureCache(orgId);
});

afterAll(async () => {
  // Org cascades into applications, candidates, stage_events, outbox, prep
  // jobs, agent events, training settings + feedback and screening calls.
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(inArray(users.id, [owner, recruiter, hrHead]));
});

const actorFor = (userId: string, email: string, via?: "agent"): LifecycleActor => ({
  orgId,
  userId,
  memberEmail: email,
  ...(via ? { via } : {}),
});

// ---------------------------------------------------------------------------
// 2. moveStageCore
// ---------------------------------------------------------------------------

describe("moveStageCore", () => {
  const ownerActor = (via?: "agent") => actorFor(owner, `pipe-owner-${stamp}@test.local`, via);

  test("non-HR roles are refused for HR-controlled offer targets", async () => {
    const { appId } = await application("applied");
    await expect(
      moveStageCore(actorFor(recruiter, `pipe-recruiter-${stamp}@test.local`), {
        applicationId: appId,
        toStage: "offer_pending",
      }),
    ).rejects.toThrow(/HR head or an owner/);
    const [app] = await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(app!.stage).toBe("applied");
    expect((await stageEventsOf(appId)).length).toBe(0);
  });

  test("the HR head can move into an offer stage, and the trail records it", async () => {
    const { appId } = await application("applied");
    const res = await moveStageCore(actorFor(hrHead, `pipe-hr-${stamp}@test.local`), {
      applicationId: appId,
      toStage: "offer_pending",
      reason: "Cleared final round",
    });
    expect(res).toEqual({ from: "applied", to: "offer_pending", unchanged: false });
    const [app] = await db
      .select({ stage: applications.stage, stageReason: applications.stageReason })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(app!.stage).toBe("offer_pending");
    expect(app!.stageReason).toBe("Cleared final round");
    const events = await stageEventsOf(appId);
    expect(events.length).toBe(1);
    expect(events[0]!.fromStage).toBe("applied");
    expect(events[0]!.toStage).toBe("offer_pending");
    expect(events[0]!.actor).toBe(`pipe-hr-${stamp}@test.local`);
  });

  test("an owner (and an agent acting for one) may move into an offer stage", async () => {
    const { appId } = await application("applied");
    const res = await moveStageCore(ownerActor("agent"), {
      applicationId: appId,
      toStage: "offer_pending",
    });
    expect(res.to).toBe("offer_pending");
    const [event] = await stageEventsOf(appId);
    expect(event!.actor).toBe(`pipe-owner-${stamp}@test.local (via agent)`);
    // No stage email: offer_pending has no candidate copy.
    expect((await stageEmailsOf(appId)).length).toBe(0);
  });

  test("a reason is required to reject (and other drop-off stages)", async () => {
    const { appId } = await application("applied");
    await expect(
      moveStageCore(ownerActor(), { applicationId: appId, toStage: "rejected" }),
    ).rejects.toThrow(/A reason is required/);
    await expect(
      moveStageCore(ownerActor(), { applicationId: appId, toStage: "withdrawn" }),
    ).rejects.toThrow(/A reason is required/);
    expect((await stageEventsOf(appId)).length).toBe(0);
  });

  test("an impossible transition is refused with the funnel explanation", async () => {
    // A closed candidate cannot re-enter mid-funnel (the pool is the way back).
    const { appId } = await application("rejected");
    await expect(
      moveStageCore(ownerActor(), { applicationId: appId, toStage: "l1" }),
    ).rejects.toThrow(/not an allowed transition/);
  });

  test("moving into an interview with no screening on record requires a note, recorded as Screening skipped", async () => {
    const refused = await application("applied");
    await expect(
      moveStageCore(ownerActor(), { applicationId: refused.appId, toStage: "l1" }),
    ).rejects.toThrow(/No screening is on record/);
    expect((await stageEventsOf(refused.appId)).length).toBe(0);

    const ok = await application("applied");
    await moveStageCore(ownerActor(), {
      applicationId: ok.appId,
      toStage: "l1",
      note: "Strong CV, direct to panel",
    });
    const [app] = await db
      .select({ stage: applications.stage, stageNote: applications.stageNote })
      .from(applications)
      .where(eq(applications.id, ok.appId));
    expect(app!.stage).toBe("l1");
    expect(app!.stageNote).toBe("Strong CV, direct to panel");
    const [event] = await stageEventsOf(ok.appId);
    expect(event!.reason).toBe("Screening skipped: Strong CV, direct to panel");
  });

  test("a recruiter may move into an interview round (no HR gate below offers)", async () => {
    const { appId } = await application("shortlisted");
    const res = await moveStageCore(actorFor(recruiter, `pipe-recruiter-${stamp}@test.local`), {
      applicationId: appId,
      toStage: "l1",
      reason: "Cleared screening",
    });
    expect(res.to).toBe("l1");
  });

  test("an open screening call refuses the interview move", async () => {
    const { appId, candidateId } = await application("applied");
    await db.insert(screeningCalls).values({
      orgId,
      candidateId,
      applicationId: appId,
      requisitionId: reqId,
      status: "approved",
      dueAt: new Date(Date.now() + 3_600_000),
    });
    await expect(
      moveStageCore(ownerActor(), { applicationId: appId, toStage: "l1", note: "skip" }),
    ).rejects.toThrow(/screening call is booked/);
    const [app] = await db
      .select({ stage: applications.stage })
      .from(applications)
      .where(eq(applications.id, appId));
    expect(app!.stage).toBe("applied");
  });

  test("a same-stage move is a no-op with no new trail row", async () => {
    const { appId } = await application("offer_pending");
    const before = (await stageEventsOf(appId)).length;
    const res = await moveStageCore(ownerActor(), {
      applicationId: appId,
      toStage: "offer_pending",
    });
    expect(res.unchanged).toBe(true);
    expect((await stageEventsOf(appId)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3. recordStageTransition effects
// ---------------------------------------------------------------------------

describe("recordStageTransition", () => {
  const move = (
    appId: string,
    toStage: Parameters<typeof recordStageTransition>[0]["toStage"],
    extra: Partial<Parameters<typeof recordStageTransition>[0]> = {},
  ) =>
    recordStageTransition({
      orgId,
      applicationId: appId,
      fromStage: "applied",
      toStage,
      actor: `pipe-recruiter-${stamp}@test.local`,
      ...extra,
    });

  test("writes the stage_events trail row", async () => {
    const { appId } = await application("applied");
    await move(appId, "ai_screened", { reason: "AI screening completed", source: "ai" });
    const [event] = await stageEventsOf(appId);
    expect(event!.fromStage).toBe("applied");
    expect(event!.toStage).toBe("ai_screened");
    expect(event!.reason).toBe("AI screening completed");
  });

  test("shortlisting enqueues a screening-prep job and the candidate email", async () => {
    const { appId } = await application("applied");
    await move(appId, "shortlisted");
    const [job] = await db
      .select()
      .from(screeningPrepJobs)
      .where(eq(screeningPrepJobs.applicationId, appId));
    expect(job!.status).toBe("pending");
    const [email] = await stageEmailsOf(appId);
    const [event] = await stageEventsOf(appId);
    expect(email!.kind).toBe("stage_update");
    expect(email!.toEmail).toContain("@cand.local");
    expect(email!.idempotencyKey).toBe(`stage:${event!.id}`);
    expect((email!.templateData as Record<string, unknown>).stageHeading).toBe(
      "You have been shortlisted",
    );
    // The orchestrator hears about the shortlist too.
    const [agentEvent] = await db
      .select()
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.orgId, orgId),
          eq(agentEvents.type, "application.shortlisted"),
          eq(agentEvents.subjectId, reqId),
        ),
      );
    expect(agentEvent).toBeTruthy();
  });

  test.each(["l1", "l2", "l3"] as const)("emails the candidate on %s", async (stage) => {
    const { appId } = await application("shortlisted");
    await move(appId, stage, { reason: "Cleared screening" });
    const [email] = await stageEmailsOf(appId);
    expect(email!.kind).toBe("stage_update");
    const headings: Record<string, string> = {
      l1: "first interview round",
      l2: "next interview round",
      l3: "final interview round",
    };
    expect((email!.templateData as Record<string, unknown>).stageHeading).toContain(
      headings[stage],
    );
  });

  test("emails the candidate on rejection, with the final marker, and never the internal reason", async () => {
    const { appId } = await application("applied");
    await move(appId, "rejected", { reason: "Compensation expectation beyond band" });
    const [email] = await stageEmailsOf(appId);
    expect(email!.kind).toBe("stage_update");
    expect((email!.templateData as Record<string, unknown>).final).toBe("yes");
    expect(JSON.stringify(email!.templateData)).not.toContain("Compensation expectation");
    // And the outcome is captured as the training reward signal.
    const [feedback] = await outcomeFeedbackOf(appId);
    expect(feedback!.label).toBe("rejected");
    expect(feedback!.actorKind).toBe("system");
  });

  test("captures the outcome for every final stage", async () => {
    for (const stage of [
      "offer_accepted",
      "joined",
      "withdrawn",
      "offer_declined",
      "no_show",
    ] as const) {
      const { appId } = await application("offer_released");
      await move(appId, stage);
      const [feedback] = await outcomeFeedbackOf(appId);
      expect(feedback!.label).toBe(stage);
    }
  });

  test("AI transitions only email on shortlisted", async () => {
    const aiL1 = await application("shortlisted");
    await move(aiL1.appId, "l1", { source: "ai", reason: "Cleared screening" });
    expect((await stageEmailsOf(aiL1.appId)).length).toBe(0);

    const aiShortlist = await application("applied");
    await move(aiShortlist.appId, "shortlisted", { source: "ai" });
    expect((await stageEmailsOf(aiShortlist.appId)).length).toBe(1);
  });

  test("scheduling an interview stays silent (the invite email covers it)", async () => {
    const { appId } = await application("shortlisted");
    await move(appId, "l1", { cause: "interview_scheduled" });
    expect((await stageEmailsOf(appId)).length).toBe(0);
  });

  test("non-copy stages write no email (but still capture outcomes)", async () => {
    const { appId } = await application("offer_released");
    await move(appId, "offer_accepted");
    expect((await stageEmailsOf(appId)).length).toBe(0);
    const [feedback] = await outcomeFeedbackOf(appId);
    expect(feedback!.label).toBe("offer_accepted");
  });

  test("a candidate with no email address gets the move but no email", async () => {
    const { appId } = await application("applied", null);
    await move(appId, "shortlisted");
    const [job] = await db
      .select()
      .from(screeningPrepJobs)
      .where(eq(screeningPrepJobs.applicationId, appId));
    expect(job).toBeTruthy(); // prep still enqueued
    expect((await stageEmailsOf(appId)).length).toBe(0); // no email to send to
  });

  test("a same-stage transition writes no email", async () => {
    const { appId } = await application("shortlisted");
    await move(appId, "shortlisted", { fromStage: "shortlisted" });
    expect((await stageEmailsOf(appId)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Source grep — the known-writers list for applications.stage
// ---------------------------------------------------------------------------

/**
 * Every file that today writes applications.stage (updates or stage-setting
 * INSERTs). Deliberately temporary: Phase 5 of the refactor funnels every
 * write through the lifecycle core and shrinks this list to empty.
 * Confirmed against the codebase at Phase 0 (branch point 39ce992):
 *  - pipeline.server.ts       moveStageCore / recordOfferStageCore updates
 *  - stage-events.server.ts   the stage_events trail (brief-listed, not the column itself)
 *  - autoscore.server.ts      auto-advance after scoring
 *  - matching.functions.ts    shortlist writer
 *  - interviews.functions.ts  round-scheduled and AI-screen-completion writers
 *  - offer-response.server.ts offer accept/decline writer
 *  - lifecycle.functions.ts   bulk stage move (found by this grep)
 *  - collaboration.functions.ts  referral INSERT with stage: "sourced"
 *  - candidates.functions.ts  create-candidate INSERT with stage: "sourced"
 */
const KNOWN_STAGE_WRITERS = [
  "src/lib/pipeline.server.ts",
  "src/lib/stage-events.server.ts",
  "src/lib/autoscore.server.ts",
  "src/lib/matching.functions.ts",
  "src/lib/interviews.functions.ts",
  "src/lib/offer-response.server.ts",
  "src/lib/lifecycle.functions.ts",
  "src/lib/collaboration.functions.ts",
  "src/lib/candidates.functions.ts",
];

/** `.set({ stage: ...` — with stage first or later inside the object. */
const SET_STAGE = /\.set\(\{[^}]*?\bstage\s*:/;
/** `insert(applications).values({ ... stage: ...` — an INSERT that sets a stage. */
const INSERT_APPLICATIONS_WITH_STAGE =
  /insert\(applications\)\s*\.\s*values\(\s*\{[\s\S]{0,400}?\bstage\s*:/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("no rogue applications.stage writers", () => {
  test("only known files write the stage column", () => {
    const root = join(import.meta.dir, "..");
    const offenders: { file: string; patterns: string[] }[] = [];
    for (const path of sourceFiles(join(root, "src"))) {
      const text = readFileSync(path, "utf8");
      const hits = [
        SET_STAGE.test(text) && "set({ stage",
        INSERT_APPLICATIONS_WITH_STAGE.test(text) && "insert(applications).values({ stage",
      ].filter(Boolean) as string[];
      if (!hits.length) continue;
      const rel = path.slice(root.length + 1);
      if (KNOWN_STAGE_WRITERS.includes(rel)) continue;
      offenders.push({ file: rel, patterns: hits });
    }
    expect(
      offenders.length
        ? `files writing applications.stage outside the known-writers list: ${offenders
            .map((o) => `${o.file} (${o.patterns.join(", ")})`)
            .join("; ")}`
        : "",
    ).toBe("");
  });
});
