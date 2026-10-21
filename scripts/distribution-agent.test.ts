/**
 * The Distribution agent (src/server/agents/distribution-agent.server.ts,
 * tools-distribution.ts, migration 0045) against the disposable database:
 *  - portal CVs are credited to their portal (careers-inbox sender) and, where
 *    the portal's terms say so, limited to their role;
 *  - a role-limited CV is never added to another role, matched, searched or
 *    invited — by a person or an agent;
 *  - role-limited CVs become due for erasure only once their roles are over,
 *    are erased only through a request the HR head approves (even for an
 *    Autonomous agent), and the audit keeps counts, never names;
 *  - quiet listings, unread inbox mail and portal CVs with no role are found;
 *  - feed listings are refused for client hires and repeats before anyone is asked;
 *  - the daily check (its health rules are tested in agent-health.test.ts).
 * No AI key is saved for the test org; nothing leaves the machine.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/distribution-agent.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentPolicies,
  agentRuns,
  applications,
  auditLog,
  candidates,
  inboxMessages,
  orgMembers,
  organizations,
  requisitionBoardPostings,
  requisitions,
  users,
} = await import("../drizzle/schema");
await import("../src/server/agents");
const channels = await import("../src/lib/job-channels");
const { inboxSource } = await import("../src/lib/local-inbox.server");
const { ingestCandidate } = await import("../src/lib/intake.server");
const { addApplicationsCore } = await import("../src/lib/pipeline.server");
const dist = await import("../src/server/agents/distribution-agent.server");
const { getTool } = await import("../src/server/agents/registry");
const { decideToolCall } = await import("../src/server/agents/policy");

const stamp = Date.now();
let orgId: string;
let userId: string;
const days = (n: number) => new Date(Date.now() - n * 864e5);
const ctx = () => ({
  orgId,
  principalUserId: userId,
  runId: "00000000-0000-0000-0000-000000000000",
  agentType: "distribution" as const,
  actor: "agent:distribution:test",
});

async function role(status = "approved", over: Record<string, unknown> = {}) {
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-DA-${Math.random().toString(36).slice(2, 7)}`,
      title: "Platform SRE",
      status,
      location: "Bengaluru",
      createdBy: userId,
      ...over,
    } as never)
    .returning({ id: requisitions.id });
  return r!.id;
}
async function person(name: string, values: Record<string, unknown> = {}) {
  const [c] = await db
    .insert(candidates)
    .values({
      orgId,
      fullName: name,
      email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@cand.local`,
      skills: ["Kubernetes"],
      ...values,
    } as never)
    .returning({ id: candidates.id });
  return c!.id;
}
async function apply(req: string, cand: string, stage: string, source: string, lastActive = 0) {
  await db.insert(applications).values({
    orgId,
    requisitionId: req,
    candidateId: cand,
    stage,
    source,
    lastActivityAt: days(lastActive),
  } as never);
}
const limited = (source = "naukri", created = 60) => ({
  poolUse: "role_only",
  poolUseSource: source,
  createdAt: days(created),
});

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `da-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Dist Org", slug: `da-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  await db.insert(orgMembers).values({
    orgId,
    userId,
    email: `da-${stamp}@test.local`,
    status: "active",
    isOwner: true,
  } as never);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(agentPolicies).where(eq(agentPolicies.orgId, orgId));
  await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
  await db.delete(candidates).where(eq(candidates.orgId, orgId));
  await db.delete(inboxMessages).where(eq(inboxMessages.orgId, orgId));
});

/* ------------------------------------------------------------- crediting */

describe("portal CVs are credited and limited by the portal's terms", () => {
  test("sender domains name the portal; anyone else is the careers inbox", () => {
    expect(inboxSource("alerts@naukri.com")).toBe("naukri");
    expect(inboxSource("noreply@mail.internshala.com")).toBe("internshala");
    expect(inboxSource("asha@gmail.com")).toBe("careers_inbox");
    expect(inboxSource("x@evilnaukri.com")).toBe("careers_inbox");
    expect(inboxSource(null)).toBe("careers_inbox");
    expect(channels.poolUseFor("naukri")).toBe("role_only");
    expect(channels.poolUseFor("internshala")).toBe("role_only");
    expect(channels.poolUseFor("jobhai")).toBe("role_only");
    expect(channels.poolUseFor("apna")).toBe("pool");
    expect(channels.poolUseFor("careers_inbox")).toBe("pool");
    for (const c of channels.JOB_CHANNELS.filter((x) => x.dataUse === "role_only"))
      expect(c.dataUseNote?.length).toBeGreaterThan(20);
  });

  test("a new candidate from a limiting portal is role-only; an existing pool record keeps its rule", async () => {
    const r = await role();
    const parsed = (email: string) => ({ full_name: "Meena", email, skills: ["Go"] }) as never;
    const fresh = await ingestCandidate({
      resumeText: "Meena — Go engineer with eight years of platform work.",
      fileName: "meena.pdf",
      requisitionId: r,
      orgId,
      source: "naukri",
      parsed: parsed(`meena-${stamp}@cand.local`),
    });
    const [m] = await db.select().from(candidates).where(eq(candidates.id, fresh.candidateId));
    expect(m).toMatchObject({ poolUse: "role_only", poolUseSource: "naukri", source: "naukri" });

    const existing = await person("Ravi", { email: `ravi-${stamp}@cand.local` });
    await ingestCandidate({
      resumeText: "Ravi — SRE with Kubernetes and Go across five years.",
      fileName: "ravi.pdf",
      requisitionId: r,
      orgId,
      source: "internshala",
      parsed: parsed(`ravi-${stamp}@cand.local`),
    });
    const [rv] = await db.select().from(candidates).where(eq(candidates.id, existing));
    expect(rv!.poolUse).toBe("pool");
    // Where Ravi first came from is kept; this arrival is credited on the application.
    expect(rv!.source).not.toBe("internshala");
    const [app] = await db
      .select({ source: applications.source })
      .from(applications)
      .where(and(eq(applications.candidateId, existing), eq(applications.requisitionId, r)));
    expect(app!.source).toBe("internshala");
  });
});

/* ---------------------------------------------------------------- reuse */

describe("a role-limited CV is never reused", () => {
  test("not added to another role, by anyone", async () => {
    const a = await role();
    const b = await role();
    const meena = await person("Meena", limited("naukri", 1));
    await apply(a, meena, "applied", "naukri");
    await expect(
      addApplicationsCore({ orgId, userId, memberEmail: "x", via: "user" } as never, {
        requisitionId: b,
        candidateIds: [meena],
        source: "talent_pool",
      }),
    ).rejects.toThrow(/Meena came from Naukri, whose terms limit the CV to the role it was for/);
    const ok = await person("Asha");
    await addApplicationsCore({ orgId, userId, memberEmail: "x", via: "user" } as never, {
      requisitionId: b,
      candidateIds: [ok],
      source: "talent_pool",
    });
  });

  test("never shown to a partner organisation through a pool share", async () => {
    const { sharedFrom } = await import("../src/lib/pool-share");
    const shared = await person("Shared");
    const kept = await person("Kept", limited("internshala", 1));
    const visible = (
      await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(sharedFrom([orgId]))
    ).map((r) => r.id);
    expect(visible).toContain(shared);
    expect(visible).not.toContain(kept);
  });

  test("not searched, matched or invited", async () => {
    const past = await role("closed");
    const open = await role("approved", { mustHaveSkills: ["Kubernetes"] });
    const limitedPerson = await person("Meena", { ...limited("naukri", 1), consentGiven: true });
    const poolPerson = await person("Priya", { consentGiven: true });
    await apply(past, limitedPerson, "l1", "naukri");
    await apply(past, poolPerson, "l1", "careers_site");
    const { pastCandidates } = await import("../src/server/agents/sourcing.server");
    const invited = (await pastCandidates(orgId, open)).matches.map((m) => m.candidateId);
    expect(invited).toContain(poolPerson);
    expect(invited).not.toContain(limitedPerson);
    const { searchTalentPool } = await import("../src/server/agents/talent-search.server");
    const found = (await searchTalentPool(orgId, open, 20)) as unknown as {
      matches: { candidateId: string }[];
    };
    expect(found.matches.map((m) => m.candidateId)).not.toContain(limitedPerson);
  });
});

/* -------------------------------------------------------------- retention */

describe("role-limited CVs are erased only once their roles are over, with approval", () => {
  test("which CVs are due", async () => {
    const closed = await role("closed");
    const open = await role();
    const due = await person("Due", limited());
    await apply(closed, due, "rejected", "naukri", 40);
    const recent = await person("Recent", limited());
    await apply(closed, recent, "rejected", "naukri", 5);
    const stillOpen = await person("Open", limited());
    await apply(open, stillOpen, "shortlisted", "naukri", 40);
    const turnedDownInOpen = await person("TurnedDown", limited("internshala"));
    await apply(open, turnedDownInOpen, "rejected", "internshala", 40);
    const hired = await person("Hired", limited());
    await apply(closed, hired, "joined", "naukri", 40);
    const noRole = await person("NoRole", limited("jobhai", 45));
    const pool = await person("Pool", { createdAt: days(90) });
    await apply(closed, pool, "rejected", "careers_site", 40);

    const r = await dist.restrictedPastRetention(orgId);
    expect(r.candidates.map((c) => c.name).sort()).toEqual(["Due", "NoRole", "TurnedDown"]);
    expect(r.candidates.find((c) => c.name === "Due")).toMatchObject({
      portal: "Naukri",
      why: expect.stringMatching(/Naukri's terms/),
    });
    expect(noRole && stillOpen && hired && recent).toBeTruthy();
  });

  test("the erasure tool always asks the HR head, even for an Autonomous agent", () => {
    const t = getTool("request_role_limited_cv_erasure")!;
    expect(t.risk).toBe("external");
    expect(t.approverRole).toBe("hr_head");
    expect(t.templateOf).toBeUndefined();
    for (const autonomy of ["suggest", "act_and_notify", "autonomous"] as const)
      expect(
        decideToolCall(t.risk, { autonomy, whitelistedTemplates: ["job_board:jooble"] }, null),
      ).toBe("approve");
    // Feed listings follow the job-board rule: only a pre-approved feed, only Autonomous.
    const feed = getTool("request_feed_listing")!;
    const tpl = feed.templateOf!({ requisitionId: "x", channel: "jooble" } as never);
    expect(tpl).toBe("job_board:jooble");
    expect(
      decideToolCall("external", { autonomy: "autonomous", whitelistedTemplates: [tpl!] }, tpl),
    ).toBe("run");
    expect(
      decideToolCall("external", { autonomy: "act_and_notify", whitelistedTemplates: [tpl!] }, tpl),
    ).toBe("approve");
  });

  test("erasure removes only what is still due, and the audit keeps counts, not names", async () => {
    const closed = await role("closed");
    const open = await role();
    const due = await person("Meena", limited());
    await apply(closed, due, "rejected", "naukri", 40);
    const back = await person("Back", limited());
    await apply(closed, back, "rejected", "naukri", 40);
    await apply(open, back, "applied", "naukri", 0); // back in an open role since
    const t = getTool("request_role_limited_cv_erasure")!;
    expect(await t.precheck!(ctx(), { candidateIds: [back] } as never)).toMatch(/None of these/);
    expect(await t.precheck!(ctx(), { candidateIds: [due, back] } as never)).toBeNull();
    const out = (await t.run(ctx(), { candidateIds: [due, back] } as never)) as {
      erased: string[];
      skipped: number;
    };
    expect(out).toEqual({ erased: ["Meena"], skipped: 1 });
    expect(await db.select().from(candidates).where(eq(candidates.id, due))).toHaveLength(0);
    expect(await db.select().from(candidates).where(eq(candidates.id, back))).toHaveLength(1);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "candidate.erase_role_limited")));
    expect(a!.detail).toMatchObject({ erased: 1, skipped: 1, sources: ["naukri"] });
    expect(JSON.stringify(a!.detail)).not.toContain("Meena");
  });
});

/* --------------------------------------------------------------- inflow */

describe("what comes back", () => {
  test("quiet listings, unread inbox mail and portal CVs with no role", async () => {
    const r = await role();
    await db.insert(requisitionBoardPostings).values([
      {
        orgId,
        requisitionId: r,
        provider: "internshala",
        status: "published",
        publishedAt: days(10),
      },
      { orgId, requisitionId: r, provider: "apna", status: "published", publishedAt: days(10) },
      { orgId, requisitionId: r, provider: "jooble", status: "published", publishedAt: days(2) },
      {
        orgId,
        requisitionId: r,
        provider: "google_jobs",
        status: "published",
        publishedAt: days(30),
      },
    ]);
    await apply(r, await person("Asha", { source: "apna" }), "applied", "apna", 1);
    await person("Loose", { source: "workindia" });
    await db.insert(inboxMessages).values({ orgId, status: "error", subject: "CV" } as never);
    const out = await dist.cvInflow(orgId);
    expect(out.quietListings.map((q) => q.channel)).toEqual(["internshala"]);
    expect(out.quietListings[0]!.howCvsComeBack).toMatch(/Excel export/);
    expect(out.inboxMailNotRead7d).toBe(1);
    expect(out.portalCvsWithNoRole14d).toBe(1);
    expect(out.last7Days).toEqual([{ source: "Apna", cvs: 1 }]);

    const rc = await dist.roleChannels(orgId, r);
    expect(rc.quiet.map((q) => q.channel)).toEqual(["internshala"]);
    expect(rc.channels.find((c) => c.channel === "apna")).toMatchObject({ live: true, cvs: 1 });
    expect(rc.channels.find((c) => c.channel === "naukri")).toMatchObject({
      live: false,
      dataUse: "role_only",
    });
    expect(JSON.stringify(rc)).not.toMatch(/budget|band|weight/i);
  });

  test("feed listings are refused for client hires, repeats and unapproved roles before anyone is asked", async () => {
    const t = getTool("request_feed_listing")!;
    expect(t.describe!({ requisitionId: "x", channel: "jooble" } as never)).toBe(
      "List the role on the Jooble job feed",
    );
    const client = await role("approved", { clientName: "Globex" });
    expect(await t.precheck!(ctx(), { requisitionId: client, channel: "jooble" } as never)).toMatch(
      /hired for a client/,
    );
    const draft = await role("pending_hr");
    expect(await t.precheck!(ctx(), { requisitionId: draft, channel: "jooble" } as never)).toMatch(
      /not approved/,
    );
    const ok = await role();
    expect(await t.precheck!(ctx(), { requisitionId: ok, channel: "jooble" } as never)).toBeNull();
    const res = (await t.run(ctx(), { requisitionId: ok, channel: "jooble" } as never)) as {
      feedLinksCreated: boolean;
      note: string;
    };
    expect(res.feedLinksCreated).toBe(false);
    expect(res.note).toMatch(/not created yet/);
    expect(await t.precheck!(ctx(), { requisitionId: ok, channel: "jooble" } as never)).toMatch(
      /already on the Jooble feed/,
    );
  });
});

/* ------------------------------------------------- health and scheduling */

describe("the daily check", () => {
  test("the daily check starts once a day, only where the agent is on", async () => {
    const { scheduleSweeps } = await import("../src/server/agents/orchestrator.server");
    const runs = () =>
      db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentType, "distribution")));
    await scheduleSweeps({ orgId });
    expect(await runs()).toHaveLength(0);
    await db.insert(agentPolicies).values({ orgId, agentType: "distribution", enabled: true });
    await scheduleSweeps({ orgId });
    await scheduleSweeps({ orgId });
    const r = await runs();
    expect(r).toHaveLength(1);
    expect(r[0]!.subjectId).toBeNull();
    expect(r[0]!.goal).toMatch(/^Daily check/);
  });
});
