/**
 * Hiring desk clarity, against the disposable database:
 *  - agent text: "Application ID:" lines left empty by id-stripping go; tool
 *    names and true/false flags become words; emails, file names, links and
 *    code blocks are untouched; long text is kept whole (clipped only at a
 *    paragraph, with where the rest is) and folded behind "Show more";
 *  - action cards a later step overtook fold (older ranked lists, "bring
 *    candidates in" once candidates arrived or an offer is in play);
 *  - "new applicants" never repeats desk uploads or people already ranked;
 *  - the JD agent's late recap is not posted after the desk announced approval;
 *  - re-scoring says what changed so earlier messages read as out of date;
 *  - a job board with only a placeholder row is not "connected";
 *  - interview times are given in the organisation's time zone; plurals.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/desk-clarity.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  agentRuns,
  applications,
  candidates,
  hiringConversations,
  hiringMessages,
  organizations,
  requisitions,
  users,
} = await import("../drizzle/schema");
const desk = await import("../src/server/desk/desk.server");
const view = await import("../src/lib/desk-view");
const { isBoardConnected } = await import("../src/server/agents/sourcing.server");
const { localWhen } = await import("../src/server/agents/tools-phase3");

const stamp = Date.now();
let orgId: string;
let userId: string;
let role: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `desk-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Desk Org", slug: `desk-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  role = (
    await db
      .insert(requisitions)
      .values({
        orgId,
        code: `REQ-D-${stamp}`,
        title: "AI Lead",
        status: "approved",
        createdBy: userId,
      } as never)
      .returning({ id: requisitions.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

async function thread() {
  const [c] = await db
    .insert(hiringConversations)
    .values({
      orgId,
      createdBy: userId,
      requisitionId: role,
      status: "active",
      createdAt: new Date(Date.now() - 3600_000),
    } as never)
    .returning();
  return c!;
}
const bodies = async (id: string) =>
  (
    await db
      .select()
      .from(hiringMessages)
      .where(eq(hiringMessages.conversationId, id))
      .orderBy(hiringMessages.createdAt)
  ).map((m) => m.body);
async function applicant(name: string, source: string) {
  const [c] = await db
    .insert(candidates)
    .values({ orgId, fullName: name, email: `${name.toLowerCase()}-${stamp}@cand.local` })
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId, requisitionId: role, candidateId: c!.id, stage: "applied", source } as never)
    .returning({ id: applications.id });
  return a!.id;
}

/* ------------------------------------------------------------ agent text */

describe("agent text for people", () => {
  const id = "b701a84d-f47e-4217-b65a-8a12986ab159";

  test("labels left empty by id-stripping go, in any markdown dress", () => {
    const out = desk.readableAgentText(
      `Role: Head of AI (REQ-2026-001)  \n**Application ID:** \`${id}\`  \nCandidate ID: ${id}\n- **Requisition**: ${id}\nRound: L1`,
    );
    expect(out).toBe("Role: Head of AI (REQ-2026-001)  \nRound: L1");
  });

  test("entity words go with their ids, and what an earlier pass left of them", () => {
    expect(
      desk.readableAgentText(`Reviewed Asha (Application ${id}, Requisition ${id}) today.`),
    ).toBe("Reviewed Asha today.");
    expect(desk.readableAgentText("Reviewed Asha (Application, Requisition) today.")).toBe(
      "Reviewed Asha today.",
    );
    expect(desk.readableAgentText("Moved (Application review done).")).toBe(
      "Moved (Application review done).",
    );
  });

  test("tool names and flags become words; emails, files, links and code stay", () => {
    const out = desk.readableAgentText(
      "Checked departments (list_departments returned none). Round L3 complete (finalComplete: true); isFinal=false\nWrite to first_last@acme.com about payslip_sep.pdf — see http://x.local/apply/a_b\n```text\nkeep_this_code\n```",
    );
    expect(out).toContain("(list departments returned none)");
    expect(out).toContain("Round L3 complete\nWrite");
    expect(out).not.toMatch(/finalComplete|isFinal|true|false/);
    expect(out).toContain("first_last@acme.com");
    expect(out).toContain("payslip_sep.pdf");
    expect(out).toContain("http://x.local/apply/a_b");
    expect(out).toContain("keep_this_code");
  });

  test("a removed flag leaves no empty backticks behind", () => {
    expect(
      desk.readableAgentText(
        "Round L3 complete; final interview round completed (`finalComplete: true`).",
      ),
    ).toBe("Round L3 complete; final interview round completed.");
  });

  test("activity previews: ids and markdown out, cut at a word", () => {
    const id = "b701a84d-f47e-4217-b65a-8a12986ab159";
    const out = desk.plainPreview(
      `The candidate for application ${id} (REQ-2026-001) shared their CTC.\nRequisition id: ${id}\n### Supply Verdict **Starving** — only \`1\` applicant\n- Added: none`,
      200,
    );
    expect(out).toBe(
      "The candidate for application (REQ-2026-001) shared their CTC. Supply Verdict Starving — only 1 applicant Added: none",
    );
    expect(desk.plainPreview("word ".repeat(100), 50)!.endsWith("word…")).toBe(true);
    expect(desk.plainPreview(null, 10)).toBeNull();
  });

  test("long text is kept whole up to the limit and clipped at a paragraph", () => {
    const para = "Word ".repeat(200).trim();
    const long = Array.from({ length: 20 }, () => para).join("\n\n");
    const clipped = desk.clipText(long, 5000);
    expect(clipped.length).toBeLessThan(5000);
    expect(clipped).toMatch(/Word\n\n… The full text is in Agent activity\.$/);
    expect(desk.clipText("short", 5000)).toBe("short");
    const f = view.foldText(long);
    expect(f.folded).toBe(true);
    expect(f.head.endsWith("Word")).toBe(true);
    expect(view.foldText("short").folded).toBe(false);
  });

  test("older messages read the same: UTC times, empty ID labels, (s) plurals", () => {
    const old = [
      "Wednesday, October 14, 2026 at 08:30 UTC (14:00 IST)",
      "October 15, 2026, at 06:00 UTC (11:30 IST)",
      "Offered Times (UTC):",
      "2026-10-14 10:30:00 UTC (16:00 IST)",
      "Offer Expiration: 2026-10-14 08:30:00 UTC",
      "Application ID:  ",
      "**Candidate ID:**  ",
      "Interviewer(s): madhu.r@yavar.ai",
      "**Interviewer(s):** madhu.r@yavar.ai",
      "Panel(s): a@x.com, b@x.com",
      "Only 1 candidate(s) so far; 3 offer(s) open.",
      "Keep only http(s): links",
    ].join("\n");
    expect(desk.tidyForPeople(old, "Asia/Kolkata").split("\n")).toEqual([
      "Wed 14 Oct, 14:00 IST",
      "Thu 15 Oct, 11:30 IST",
      "Offered Times:",
      "Wed 14 Oct, 16:00 IST",
      "Offer Expiration: Wed 14 Oct, 14:00 IST",
      "Interviewer: madhu.r@yavar.ai",
      "**Interviewer:** madhu.r@yavar.ai",
      "Panels: a@x.com, b@x.com",
      "Only 1 candidate so far; 3 offers open.",
      "Keep only http(s): links",
    ]);
  });

  test("plurals", () => {
    expect(desk.plural(1, "candidate")).toBe("1 candidate");
    expect(desk.plural(3, "candidate")).toBe("3 candidates");
  });

  test("interview times in the organisation's time zone", () => {
    expect(localWhen("2026-10-14T08:30:00.000Z", "Asia/Kolkata")).toBe("Wed 14 Oct, 14:00 IST");
    expect(localWhen("2026-10-14T08:30:00.000Z", "Europe/London")).toBe("Wed 14 Oct, 09:30 BST");
  });

  test("a board is connected only with credentials", () => {
    expect(isBoardConnected({ integrationId: "", secrets: {} })).toBe(false);
    expect(isBoardConnected({ integrationId: "x", secrets: {} })).toBe(false);
    expect(isBoardConnected({ integrationId: "x", secrets: { apiKey: " " } })).toBe(false);
    expect(isBoardConnected({ integrationId: "x", secrets: { apiKey: "k" } })).toBe(true);
    expect(isBoardConnected({ integrationId: "x", secrets: {}, accessToken: "t" })).toBe(true);
  });
});

/* ------------------------------------------------------------ cards */

describe("overtaken action cards", () => {
  const m = (id: string, type: string | null) => ({ id, card: type ? { type } : null });

  test("older ranked lists and bring-candidates fold; the latest stays live", () => {
    const s = view.supersededMessages({
      messages: [
        m("1", "bring_candidates"),
        m("2", "ranked_candidates"),
        m("3", "bring_candidates"),
        m("4", null),
        m("5", "ranked_candidates"),
      ],
      stages: { a: "shortlisted" },
    });
    expect([...s.keys()]).toEqual(["1", "2", "3"]);
    expect(s.get("2")).toMatch(/newer list/);
    expect(s.get("1")).toMatch(/candidates have arrived/);
  });

  test("with an offer in play every bring-candidates card folds", () => {
    const s = view.supersededMessages({
      messages: [m("1", "bring_candidates")],
      stages: { a: "offer_pending" },
    });
    expect(s.get("1")).toMatch(/offer in play/);
    expect(
      view.supersededMessages({ messages: [m("1", "bring_candidates")], stages: { a: "l1" } }).size,
    ).toBe(0);
  });

  test("screening is offered only for candidates still at screening", () => {
    expect(view.SCREENABLE.has("shortlisted")).toBe(true);
    expect(view.SCREENABLE.has("offer_pending")).toBe(false);
  });
});

/* ------------------------------------------------------------ thread order */

describe("thread order", () => {
  test("new applicants: not desk uploads, not people already in a ranked list", async () => {
    const conv = await thread();
    await applicant("Uploaded", "hiring_desk");
    const ranked = await applicant("Ranked", "direct");
    await desk.postMessage(conv, {
      role: "agent",
      body: "Only 1 candidate so far, best first.",
      card: { type: "ranked_candidates", items: [{ applicationId: ranked }] },
    });
    await applicant("Fresh", "careers_inbox");
    expect(await desk.announceNewApplicants(orgId)).toBe(1);
    const last = (await bodies(conv.id)).at(-1)!;
    expect(last).toMatch(/^1 new applicant: 1 via careers inbox — Fresh\./);
    expect(last).not.toMatch(/Uploaded|Ranked/);
    expect(await desk.announceNewApplicants(orgId)).toBe(0);
  });

  test("the JD agent's recap is not posted after the desk announced the approval", async () => {
    const conv = await thread();
    const [run] = await db
      .insert(agentRuns)
      .values({
        orgId,
        agentType: "jd",
        principalUserId: userId,
        goal: "g",
        status: "done",
        conversationId: conv.id,
      } as never)
      .returning({ id: agentRuns.id });
    const finish = () =>
      desk.onRunFinished({
        id: run!.id,
        conversationId: conv.id,
        orgId,
        agentType: "jd",
        status: "done",
        result: "The JD has been drafted and submitted for review.",
        error: null,
      });
    await desk.postMessage(conv, {
      role: "desk",
      body: "The job description is approved.",
      card: { type: "next_steps", items: [] },
    });
    await finish();
    expect((await bodies(conv.id)).join("\n")).not.toMatch(/drafted and submitted/);
    // Without that announcement (e.g. it was declined), the recap is posted.
    const other = await thread();
    await desk.onRunFinished({
      id: run!.id,
      conversationId: other.id,
      orgId,
      agentType: "jd",
      status: "done",
      result: "Sent back for changes.",
      error: null,
    });
    expect(await bodies(other.id)).toEqual(["Sent back for changes."]);
  });

  test("a re-score says what changed", () => {
    const before = [
      {
        applicationId: "a",
        name: "Asha",
        score: 91,
        risks: ["Future-dated tenure", "Engineering lean"],
      },
      { applicationId: "b", name: "Ravi", score: 70, risks: [] },
    ];
    const after = [
      { applicationId: "a", name: "Asha", score: 94, risks: ["Engineering lean"] },
      { applicationId: "b", name: "Ravi", score: 70, risks: [] },
    ];
    const out = desk.scoreChanges(before, after)!;
    expect(out).toContain('- Asha: 91 → 94; no longer flagged: "Future-dated tenure"');
    expect(out).not.toContain("Ravi");
    expect(out).toMatch(
      /Earlier messages in this thread that quote the old scores or flags are out of date/,
    );
    expect(desk.scoreChanges(before.slice(1), after.slice(1))).toBeNull();
  });
});
