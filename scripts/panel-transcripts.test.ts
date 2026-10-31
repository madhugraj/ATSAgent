/**
 * Silent panel agents, S1 (docs/silent-panel-agent-plan.md): the switch,
 * transcription requested at booking (and the candidate told), the opt-out,
 * and the sweep that fetches the transcript after the call. The meeting
 * provider (Teams, delegated) is a stub; nothing leaves the machine.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test bun test scripts/panel-transcripts.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentEvents,
  applications,
  auditLog,
  candidates,
  emailOutbox,
  interviews,
  interviewTranscripts,
  organizations,
  requisitions,
  sourceIntegrations,
  users,
} = await import("../drizzle/schema");
const panel = await import("../src/server/panel/transcripts.server");
const { scheduleInterviewCore } = await import("../src/lib/interviews.functions");
const { writeSecrets } = await import("../src/lib/integrations.server");

const stamp = Date.now();
const JOIN = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_s1-${stamp}%40thread.v2/0`;
let orgId: string;
let userId: string;
let applicationId: string;

/* ---------------------------------------------------- the Teams stub */

type Call = { method: string; url: string; body?: string };
let calls: Call[] = [];
let transcriptsReady = false;
const realFetch = globalThis.fetch;

function stubTeams() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.startsWith("https://login.microsoftonline.com/")) return json({ access_token: "t" });
    if (url.includes("/me/onlineMeetings?$filter=")) return json({ value: [{ id: "m1" }] });
    if (url.endsWith("/me/onlineMeetings/m1") && method === "PATCH") return json({});
    if (url.endsWith("/onlineMeetings/m1/transcripts"))
      return json({
        value: transcriptsReady ? [{ id: "t1", createdDateTime: "2026-10-31T10:00:00Z" }] : [],
      });
    if (url.includes("/onlineMeetings/m1/transcripts/t1/content"))
      return new Response(
        "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Panel One>Tell us about your last project.</v>\n\n00:00:04.000 --> 00:00:08.000\n<v Candidate>I built the search ranking service.</v>\n",
        { status: 200 },
      );
    return new Response("not stubbed", { status: 599 });
  }) as typeof fetch;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const [u] = await db
    .insert(users)
    .values({ email: `panel-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Panel Org", slug: `panel-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [req] = await db
    .insert(requisitions)
    .values({ orgId, code: `P-${stamp}`, title: "ML Engineer", status: "approved" } as never)
    .returning({ id: requisitions.id });
  const [cand] = await db
    .insert(candidates)
    .values({ orgId, fullName: "Asha", email: `asha-${stamp}@cand.local` } as never)
    .returning({ id: candidates.id });
  const [app] = await db
    .insert(applications)
    .values({ orgId, requisitionId: req!.id, candidateId: cand!.id, stage: "l1" } as never)
    .returning({ id: applications.id });
  applicationId = app!.id;
  const [integration] = await db
    .insert(sourceIntegrations)
    .values({
      orgId,
      provider: "teams",
      label: "Microsoft Teams",
      category: "meetings",
      enabled: true,
      hasCredentials: true,
    } as never)
    .returning({ id: sourceIntegrations.id });
  await writeSecrets(integration!.id, {
    refresh_token: "r",
    scope: "https://graph.microsoft.com/OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All",
  });
  stubTeams();
});

afterEach(() => {
  calls = [];
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

const actor = () => ({ userId, memberEmail: `panel-${stamp}@test.local` });

async function book(level: number, at: Date, link: string | null = JOIN) {
  const r = await scheduleInterviewCore(
    { orgId, actor: "test" },
    {
      applicationId,
      level,
      scheduledAt: at.toISOString(),
      durationMins: 30,
      mode: "online",
      meetingLink: link,
      interviewer: null,
      interviewerEmail: null,
      agenda: null,
      panel: [],
    },
  );
  return r.interviewId!;
}

async function round(id: string) {
  const [r] = await db.select().from(interviews).where(eq(interviews.id, id));
  return r!;
}

/* -------------------------------------------------------------- tests */

describe("switch and booking", () => {
  test("off by default: a booked round records its meeting but is not transcribed", async () => {
    expect(await panel.panelAgentPolicyOf(orgId)).toEqual({ enabled: false, levels: [1, 2, 3] });
    const id = await book(1, new Date(Date.now() + 864e5));
    const r = await round(id);
    expect(r.meetingProvider).toBe("teams");
    expect(r.meetingExternalId).toBe(JOIN);
    expect(r.transcription).toBe("off");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await db.delete(interviews).where(eq(interviews.id, id));
  });

  test("switched on for L1: the round asks the provider to transcribe and the invite says so", async () => {
    await panel.setPanelAgentPolicyCore(orgId, actor(), { enabled: true, levels: [1] });
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "panel_agent.settings_changed")));
    expect(audit).toHaveLength(1);

    const id = await book(1, new Date(Date.now() + 864e5));
    const r = await round(id);
    expect(r.transcription).toBe("requested");
    expect(r.transcriptionDetail).toBeNull();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.body!)).toEqual({ recordAutomatically: true });

    const [mail] = await db
      .select({ data: emailOutbox.templateData })
      .from(emailOutbox)
      .where(
        and(eq(emailOutbox.applicationId, applicationId), eq(emailOutbox.kind, "interview_invite")),
      )
      .orderBy(desc(emailOutbox.createdAt))
      .limit(1);
    expect((mail?.data as Record<string, string>)["transcribed"]).toBe("yes");
    await db.delete(interviews).where(eq(interviews.id, id));
  });

  test("a round the agent is not on for, or with no readable meeting, stays off", async () => {
    const l2 = await book(2, new Date(Date.now() + 2 * 864e5));
    expect((await round(l2)).transcription).toBe("off");
    const pasted = await book(1, new Date(Date.now() + 3 * 864e5), "https://webex.com/meet/x");
    expect((await round(pasted)).meetingProvider).toBeNull();
    expect((await round(pasted)).transcription).toBe("off");
    await db.delete(interviews).where(eq(interviews.id, l2));
    await db.delete(interviews).where(eq(interviews.id, pasted));
  });

  test("readiness: the Teams grant includes transcript access", async () => {
    expect(await panel.panelAgentReadiness(orgId)).toEqual([
      { provider: "teams", label: "Microsoft Teams", transcripts: "granted" },
    ]);
  });
});

describe("after the call", () => {
  test("not yet: checked, backed off; then fetched, stored and announced", async () => {
    // A call that ended 20 minutes ago.
    const id = await book(1, new Date(Date.now() - 50 * 60_000));
    expect((await round(id)).transcription).toBe("requested");
    calls = [];

    transcriptsReady = false;
    expect(await panel.sweepTranscripts(orgId)).toBe(0);
    let r = await round(id);
    expect(r.transcription).toBe("requested");
    expect(r.transcriptChecks).toBe(1);
    expect(r.transcriptionDetail).toContain("no transcript");

    // Checked a moment ago: not due again yet.
    calls = [];
    await panel.sweepTranscripts(orgId);
    expect(calls).toHaveLength(0);

    transcriptsReady = true;
    await db.update(interviews).set({ transcriptCheckedAt: null }).where(eq(interviews.id, id));
    expect(await panel.sweepTranscripts(orgId)).toBe(1);
    r = await round(id);
    expect(r.transcription).toBe("ready");
    const [t] = await db
      .select()
      .from(interviewTranscripts)
      .where(eq(interviewTranscripts.interviewId, id));
    expect(t!.segmentCount).toBe(2);
    expect(t!.segments[1]).toMatchObject({
      speaker: "Candidate",
      text: "I built the search ranking service.",
    });
    const events = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.type, "interview.transcript_ready")));
    expect(events.map((e) => e.subjectId)).toEqual([applicationId]);

    // The candidate declines afterwards: the transcript is deleted, audited.
    await panel.declineRoundTranscriptionCore(
      { orgId, userId, email: actor().memberEmail },
      id,
      "replied to the invite",
    );
    r = await round(id);
    expect(r.transcription).toBe("candidate_declined");
    expect(
      await db.select().from(interviewTranscripts).where(eq(interviewTranscripts.interviewId, id)),
    ).toHaveLength(0);
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.orgId, orgId), eq(auditLog.action, "interview.transcription_declined")),
      );
    expect(audit).toHaveLength(1);
    // A later re-booking does not switch it back on.
    await scheduleInterviewCore(
      { orgId, actor: "test" },
      {
        applicationId,
        level: 1,
        interviewId: id,
        rescheduleReason: "moved",
        scheduledAt: new Date(Date.now() + 864e5).toISOString(),
        durationMins: 30,
        mode: "online",
        meetingLink: JOIN,
        interviewer: null,
        interviewerEmail: null,
        agenda: null,
        panel: [],
      },
    );
    expect((await round(id)).transcription).toBe("candidate_declined");
    await db.delete(interviews).where(eq(interviews.id, id));
  });

  test("declined before the call: switched off with the provider", async () => {
    const id = await book(1, new Date(Date.now() + 864e5));
    calls = [];
    await panel.declineRoundTranscriptionCore({ orgId, userId, email: "x@test.local" }, id, "");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.body!)).toEqual({ recordAutomatically: false });
    await db.delete(interviews).where(eq(interviews.id, id));
  });

  test("nothing within 6 hours of the end: unavailable, with the last answer", async () => {
    transcriptsReady = false;
    const id = await book(1, new Date(Date.now() - 7 * 3600_000));
    await panel.sweepTranscripts(orgId);
    const r = await round(id);
    expect(r.transcription).toBe("unavailable");
    expect(r.transcriptionDetail).toContain("within 6 hours");
    await db.delete(interviews).where(eq(interviews.id, id));
  });

  test("switched off: rounds are no longer fetched", async () => {
    const id = await book(1, new Date(Date.now() - 50 * 60_000));
    await panel.setPanelAgentPolicyCore(orgId, actor(), { enabled: false, levels: [1] });
    calls = [];
    await panel.sweepTranscripts(orgId);
    expect(calls).toHaveLength(0);
    await db.delete(interviews).where(eq(interviews.id, id));
  });
});
