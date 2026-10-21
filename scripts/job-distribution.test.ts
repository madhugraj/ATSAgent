/**
 * Job distribution (migration 0044), against the disposable database:
 *  - tracked apply links: only known sources are recorded, Google's apply
 *    clicks are recognised, anything else is the careers site;
 *  - Google for Jobs: structured data only for approved, listed, complete
 *    roles of organisations that switched it on; nothing internal leaks; the
 *    Indexing API queue follows each role, within the daily quota;
 *  - job feeds: well-formed XML per aggregator, only the roles a person put
 *    on that feed, never another organisation's, never a client hire, and a
 *    replaced link stops working at once;
 *  - posting by hand: contact details stripped, links checked, audited;
 *  - the per-channel report counts how far applicants got.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/job-distribution.test.ts
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DOMParser } from "@xmldom/xmldom";
import { and, eq, inArray } from "drizzle-orm";

// Feed tokens are stored with encryptSecret; give the test run a key of its own.
process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env["GOOGLE_INDEXING_CREDENTIALS"] = JSON.stringify({
  client_email: "indexer@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

const { db } = await import("../src/server/db");
const { env } = await import("../src/server/env");
const {
  applications,
  auditLog,
  candidates,
  jobDescriptions,
  jobIndexNotifications,
  orgJobDistribution,
  organizations,
  requisitionBoardPostings,
  requisitions,
  stageEvents,
  users,
} = await import("../drizzle/schema");
const channels = await import("../src/lib/job-channels");
const content = await import("../src/server/distribution/content");
const dist = await import("../src/server/distribution/distribution.server");
const indexing = await import("../src/server/distribution/google-indexing.server");
const { submitApplicationImpl } = await import("../src/lib/apply.functions");
const { closePostingsForRequisition } = await import("../src/server/boards/publish.server");

const stamp = Date.now();
let orgA: string;
let orgB: string;
let userId: string;
const actor = () => ({ memberEmail: `hr-${stamp}@test.local`, userId });

const JD = [
  "## About the role",
  "You will run our **Kubernetes** platform. Write to jobs@acme.example or call +91 98765 43210.",
  "",
  "- Own the clusters",
  "- Keep the lights on <script>alert(1)</script>",
  "",
  "See https://acme.example/careers for more. Tags: a ]]> b",
].join("\n");

async function role(
  orgId: string,
  over: Partial<typeof requisitions.$inferInsert> = {},
  jd: string | null = JD,
): Promise<string> {
  const [r] = await db
    .insert(requisitions)
    .values({
      orgId,
      code: `REQ-D-${Math.random().toString(36).slice(2, 8)}`,
      title: "Platform SRE",
      status: "approved",
      location: "Bengaluru / Chennai",
      openings: 2,
      experienceMin: 4,
      experienceMax: 8,
      budgetCtc: "4500000",
      ctcBandMin: "3000000",
      ctcBandMax: "4000000",
      mustHaveSkills: ["Kubernetes", "Go"],
      goodToHaveSkills: ["Terraform"],
      responsibilities: "Run the platform.",
      createdBy: userId,
      ...over,
    } as never)
    .returning({ id: requisitions.id });
  if (jd)
    await db.insert(jobDescriptions).values({
      requisitionId: r!.id,
      orgId,
      version: 1,
      status: "approved",
      fullText: jd,
    });
  return r!.id;
}

function wellFormed(xml: string): Document {
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level !== "warning") errors.push(msg);
    },
  }).parseFromString(xml, "text/xml") as unknown as Document;
  expect(errors).toEqual([]);
  return doc;
}

const auditActions = async (orgId: string) =>
  (
    await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, orgId))
  ).map((r) => r.action);

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `dist-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgA = (
    await db
      .insert(organizations)
      .values({ name: "Acme & Co", slug: `dist-a-${stamp}`, status: "active", hqCountry: "India" })
      .returning({ id: organizations.id })
  )[0]!.id;
  orgB = (
    await db
      .insert(organizations)
      .values({ name: "Other Org", slug: `dist-b-${stamp}`, status: "active", hqCountry: "India" })
      .returning({ id: organizations.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
  await db.delete(users).where(eq(users.id, userId));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  indexing.resetIndexingToken();
});

beforeEach(async () => {
  for (const orgId of [orgA, orgB]) {
    await db.delete(requisitions).where(eq(requisitions.orgId, orgId));
    await db.delete(orgJobDistribution).where(eq(orgJobDistribution.orgId, orgId));
    await db.delete(jobIndexNotifications).where(eq(jobIndexNotifications.orgId, orgId));
    await db.delete(candidates).where(eq(candidates.orgId, orgId));
    await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, orgId));
  }
});

/* ------------------------------------------------------------------ pure */

describe("tracked apply links", () => {
  test("only known sources are kept", () => {
    expect(channels.resolveSource("jooble")).toBe("jooble");
    expect(channels.resolveSource("Internshala")).toBe("internshala");
    expect(channels.resolveSource("linkedin_post")).toBe("linkedin_post");
    expect(channels.resolveSource("agent_talent_pool")).toBe("careers_site");
    expect(channels.resolveSource("<script>")).toBe("careers_site");
    expect(channels.resolveSource(null)).toBe("careers_site");
    expect(channels.resolveSource(null, "google_jobs_apply")).toBe("google_jobs");
    expect(channels.resolveSource("bogus", "adzuna")).toBe("adzuna");
  });

  test("links and labels", () => {
    expect(channels.trackedApplyUrl("https://x.test/", "r1", "jooble")).toBe(
      "https://x.test/apply/r1?src=jooble",
    );
    expect(channels.trackedApplyUrl("https://x.test", "r1")).toBe("https://x.test/apply/r1");
    expect(channels.trackedApplyUrl("https://x.test", "r1", "careers_site")).toBe(
      "https://x.test/apply/r1",
    );
    expect(channels.sourceLabel("jobhai")).toBe("Job Hai");
    expect(channels.sourceLabel("careers_inbox")).toBe("Careers inbox");
    expect(channels.sourceLabel("some_new_thing")).toBe("Some New Thing");
    expect(channels.UPLOAD_SOURCES).toContain("internshala");
    expect(channels.UPLOAD_SOURCES).not.toContain("google_jobs");
  });

  test("every channel is complete and unique", () => {
    const ids = channels.JOB_CHANNELS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(14);
    for (const c of channels.JOB_CHANNELS) {
      expect(c.applications.length).toBeGreaterThan(5);
      expect(c.cost.length).toBeGreaterThan(3);
      if (c.route === "feed") expect(c.feedFormat).toBe(c.id as never);
      if (c.route === "assisted" || c.route === "partner_api")
        expect(c.steps?.length).toBeGreaterThan(1);
    }
  });
});

describe("content", () => {
  const job = (
    over: Partial<import("../src/server/distribution/content").DistributableJob> = {},
  ) => ({
    id: "11111111-1111-1111-1111-111111111111",
    code: "REQ-1",
    title: "Platform </script><script>alert(1)</script> SRE",
    location: "Bengaluru / Chennai",
    workMode: null,
    openings: 2,
    experienceMin: 4,
    experienceMax: 8,
    mustHave: ["Kubernetes"],
    goodToHave: ["Go"],
    description: JD,
    company: "Acme & Co",
    country: "IN",
    countryName: "India",
    postedAt: new Date("2026-10-01T00:00:00Z"),
    forClient: false,
    ...over,
  });

  test("HTML is escaped; headings and lists survive", () => {
    const html = content.textToHtml(JD);
    expect(html).toContain("<h3>About the role</h3>");
    expect(html).toContain("<strong>Kubernetes</strong>");
    expect(html).toContain("<li>Own the clusters</li>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("contact details leave a portal posting", () => {
    const out = content.stripContactDetails(
      "Mail jobs@acme.example, call +91 98765 43210 or (080) 4567-8901, see https://acme.example and www.acme.example. 4–8 years, since 2026, 2 openings.",
    );
    expect(out).not.toMatch(/@|https?:|www\.|98765|4567/);
    expect(out).toContain("4–8 years, since 2026, 2 openings.");
  });

  test("countries", () => {
    expect(content.countryCode("India")).toBe("IN");
    expect(content.countryCode(" united  kingdom ")).toBe("GB");
    expect(content.countryCode("uk")).toBe("GB");
    expect(content.countryCode("au")).toBe("AU");
    expect(content.countryCode("Atlantis")).toBeNull();
    expect(content.countryCode(null)).toBeNull();
    expect(content.places("Bengaluru, Karnataka / Pune; Remote or Chennai")).toEqual([
      "Bengaluru, Karnataka",
      "Pune",
      "Remote",
      "Chennai",
    ]);
  });

  test("Google's structured data: required properties, nothing internal", () => {
    const ld = content.jobPostingJsonLd(job())!;
    expect(ld).toMatchObject({
      "@type": "JobPosting",
      datePosted: "2026-10-01",
      hiringOrganization: { name: "Acme & Co" },
      directApply: true,
      experienceRequirements: { monthsOfExperience: 48 },
      skills: "Kubernetes, Go",
    });
    expect((ld["jobLocation"] as unknown[]).length).toBe(2);
    expect(JSON.stringify(ld)).not.toMatch(/budget|band|ctc|weight/i);
    const script = content.jsonForScript(ld);
    expect(script).not.toContain("<");
    expect(JSON.parse(script)).toEqual(ld);
  });

  test("remote roles need a country; short descriptions are not listed", () => {
    const remote = content.jobPostingJsonLd(job({ workMode: "remote" }))!;
    expect(remote).toMatchObject({
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { "@type": "Country", name: "India" },
    });
    expect(remote["jobLocation"]).toBeUndefined();
    expect(content.jobPostingJsonLd(job({ workMode: "remote", country: null }))).toBeNull();
    expect(content.listingGaps(job({ description: "Too short." }))[0]).toMatch(/too short/);
    expect(content.jobPostingJsonLd(job({ location: null }))).toBeNull();
  });

  test("feeds are well-formed XML in each aggregator's shape", () => {
    const feedJob = { ...job(), applyUrl: "https://x.test/apply/1?src=jooble&a=b" };
    const jooble = wellFormed(content.joobleFeed([feedJob]));
    const j = jooble.getElementsByTagName("job")[0]!;
    expect(j.getAttribute("id")).toBe(feedJob.id);
    expect(j.getElementsByTagName("link")[0]!.textContent).toBe(feedJob.applyUrl);
    expect(j.getElementsByTagName("pubdate")[0]!.textContent).toBe("01.10.2026");
    expect(j.getElementsByTagName("description")[0]!.textContent).toContain("a ]]&gt; b");

    const adzuna = wellFormed(content.adzunaFeed([feedJob]));
    expect(adzuna.getElementsByTagName("country")[0]!.textContent).toBe("IN");
    expect(adzuna.getElementsByTagName("title")[0]!.textContent).toBe(feedJob.title);

    const jora = wellFormed(
      content.joraFeed([feedJob, { ...feedJob, id: "2", title: "Bad\u0001char" }], {
        name: "Acme & Co",
        url: "https://x.test",
      }),
    );
    expect(jora.getElementsByTagName("job")).toHaveLength(2);
    expect(jora.getElementsByTagName("organisation")[0]!.textContent).toBe("Acme & Co");
    expect(jora.getElementsByTagName("title")[1]!.textContent).toBe("Badchar");
  });

  test("posting text", () => {
    const text = content.packText(job(), "https://x.test/apply/1?src=apna");
    expect(text).not.toMatch(/jobs@acme|98765|acme\.example\/careers/);
    expect(text).toContain("Apply: https://x.test/apply/1?src=apna");
    expect(text).not.toContain("##");
    expect(content.packText(job(), null)).not.toContain("Apply:");
  });
});

/* ----------------------------------------------------------------- feeds */

describe("job feeds", () => {
  test("only the roles put on that feed, for that organisation, while approved", async () => {
    const listed = await role(orgA);
    const notOnFeed = await role(orgA);
    const client = await role(orgA, { clientName: "Globex" });
    const other = await role(orgB);
    await dist.addToFeed(orgA, actor(), listed, "jooble");
    await expect(dist.addToFeed(orgA, actor(), client, "jooble")).rejects.toThrow(
      /hires for itself/,
    );
    await dist.addToFeed(orgB, actor(), other, "jooble");
    // A role put on the feed and later hired for a client still never appears.
    await dist.addToFeed(orgA, actor(), notOnFeed, "adzuna");

    const urls = await dist.rotateFeedToken(orgA, actor());
    const token = urls.jooble.split("/").at(-2)!;
    const xml = (await dist.feedXml(token, "jooble"))!;
    const doc = wellFormed(xml);
    const ids = Array.from(doc.getElementsByTagName("job")).map((j) => j.getAttribute("id"));
    expect(ids).toEqual([listed]);
    expect(xml).toContain(`/apply/${listed}?src=jooble`);
    expect(xml).not.toMatch(/4500000|3000000|Globex/);

    expect(await dist.feedXml(token, "adzuna")).toContain(notOnFeed);
    expect(await dist.feedXml(token, "linkedin")).toBeNull();
    expect(await dist.feedXml("0".repeat(48), "jooble")).toBeNull();
    expect(await dist.feedXml("../../etc", "jooble")).toBeNull();

    // Closing the role takes it off.
    await db.update(requisitions).set({ status: "closed" }).where(eq(requisitions.id, listed));
    expect(await dist.feedXml(token, "jooble")).not.toContain(listed);

    // A paused organisation has no feed.
    await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgA));
    expect(await dist.feedXml(token, "jooble")).toBeNull();
  });

  test("replacing the links stops the old one; the token is stored encrypted", async () => {
    const first = (await dist.rotateFeedToken(orgA, actor())).jora.split("/").at(-2)!;
    const second = (await dist.rotateFeedToken(orgA, actor())).jora.split("/").at(-2)!;
    expect(first).not.toBe(second);
    expect(await dist.feedXml(first, "jora")).toBeNull();
    expect(await dist.feedXml(second, "jora")).toContain("<source>");
    const [row] = await db
      .select()
      .from(orgJobDistribution)
      .where(eq(orgJobDistribution.orgId, orgA));
    expect(row!.feedToken).toStartWith("enc:v1.");
    expect(row!.feedToken).not.toContain(second);
    expect((await dist.feedLinks(orgA))!.urls.jora).toContain(second);
    const actions = await auditActions(orgA);
    expect(actions).toContain("distribution.feed.create");
    expect(actions).toContain("distribution.feed.rotate");
  });

  test("feeds take approved roles only, and only feed channels", async () => {
    const draft = await role(orgA, { status: "pending_hr" });
    await expect(dist.addToFeed(orgA, actor(), draft, "jooble")).rejects.toThrow(/approved/);
    const ok = await role(orgA);
    await expect(dist.addToFeed(orgA, actor(), ok, "apna")).rejects.toThrow(/Unknown channel/);
    await expect(dist.addToFeed(orgB, actor(), ok, "jooble")).rejects.toThrow();
  });
});

/* -------------------------------------------------------- posting by hand */

describe("posting by hand", () => {
  test("mark posted, check the link, take down — all audited", async () => {
    const r = await role(orgA);
    await expect(
      dist.markPosted(orgA, actor(), r, "internshala", "javascript:alert(1)"),
    ).rejects.toThrow(/https/);
    await dist.markPosted(orgA, actor(), r, "internshala", "https://internshala.com/x");
    let s = await dist.distributionStatus(orgA, r);
    expect(s.postings.find((p) => p.provider === "internshala")).toMatchObject({
      status: "published",
      url: "https://internshala.com/x",
      viaIntegration: false,
    });
    await dist.takeDown(orgA, actor(), r, "internshala");
    s = await dist.distributionStatus(orgA, r);
    expect(s.postings.find((p) => p.provider === "internshala")!.status).toBe("closed");
    await expect(dist.takeDown(orgA, actor(), r, "internshala")).rejects.toThrow(/not live/);
    const actions = await auditActions(orgA);
    expect(actions.filter((a) => a === "board.posting.publish").length).toBeGreaterThan(0);
    expect(actions).toContain("board.posting.close");
  });

  test("an integration posting is not overwritten by a hand-posted one", async () => {
    const r = await role(orgA);
    await db.insert(requisitionBoardPostings).values({
      orgId: orgA,
      requisitionId: r,
      provider: "naukri",
      status: "published",
      externalId: "NK-1",
      publishedAt: new Date(),
    });
    await expect(dist.markPosted(orgA, actor(), r, "naukri", null)).rejects.toThrow(
      /through the integration/,
    );
  });

  test("the pack: no contact details, link only where the portal takes one", async () => {
    const r = await role(orgA);
    const apna = await dist.postingPack(orgA, r, "apna");
    expect(apna.applyUrl).toBeNull();
    expect(apna.text).not.toMatch(/jobs@acme|98765/);
    const wellfound = await dist.postingPack(orgA, r, "wellfound");
    expect(wellfound.applyUrl).toContain(`/apply/${r}?src=wellfound`);
    await expect(dist.postingPack(orgB, r, "apna")).rejects.toThrow();
    await expect(dist.postingPack(orgA, r, "jooble")).rejects.toThrow(/Unknown channel/);
  });

  test("closing a requisition closes hand-posted and feed rows without calling a board", async () => {
    const r = await role(orgA);
    await dist.markPosted(orgA, actor(), r, "apna", null);
    await dist.addToFeed(orgA, actor(), r, "adzuna");
    await closePostingsForRequisition({ orgId: orgA, actor: actor(), requisitionId: r });
    const rows = await db
      .select({
        provider: requisitionBoardPostings.provider,
        status: requisitionBoardPostings.status,
        lastError: requisitionBoardPostings.lastError,
      })
      .from(requisitionBoardPostings)
      .where(eq(requisitionBoardPostings.requisitionId, r));
    expect(rows.every((x) => x.status === "closed" && x.lastError === null)).toBe(true);
  });
});

/* -------------------------------------------------------- Google for Jobs */

describe("Google for Jobs", () => {
  test("structured data only when switched on, approved and not excluded", async () => {
    const r = await role(orgA);
    expect((await dist.publicListing(r))!.jsonLd).toBeNull();
    await dist.setGoogleJobs(orgA, actor(), true);
    expect((await dist.publicListing(r))!.jsonLd).toMatchObject({ title: "Platform SRE" });
    await dist.setRoleOnGoogle(orgA, actor(), r, false);
    expect((await dist.publicListing(r))!.jsonLd).toBeNull();
    await dist.setRoleOnGoogle(orgA, actor(), r, true);
    expect((await dist.publicListing(r))!.jsonLd).not.toBeNull();
    await db.update(requisitions).set({ status: "on_hold" }).where(eq(requisitions.id, r));
    expect(await dist.publicListing(r)).toBeNull();
    const actions = await auditActions(orgA);
    expect(actions).toContain("distribution.google_jobs.set");
    expect(actions).toContain("distribution.google_jobs.exclude");
  });

  test("Google is told when a role opens and closes; one waiting notice per page", async () => {
    const r = await role(orgA);
    const gap = await role(orgA, { location: null, workMode: "onsite" });
    await dist.setGoogleJobs(orgA, actor(), true);
    const notices = () =>
      db.select().from(jobIndexNotifications).where(eq(jobIndexNotifications.orgId, orgA));
    let n = await notices();
    expect(n.map((x) => [x.requisitionId, x.kind, x.status])).toEqual([
      [r, "URL_UPDATED", "pending"],
    ]);
    expect(n[0]!.url).toMatch(new RegExp(`/apply/${r}$`));
    expect((await dist.distributionStatus(orgA, gap)).google).toMatchObject({
      listed: false,
      gaps: ["Add the role's location."],
    });

    // Nothing changes on a second pass.
    expect(await dist.reconcileGoogleListings(orgA)).toEqual({ listed: 0, unlisted: 0 });

    // Closing it replaces the waiting notice instead of adding a second one.
    await db.update(requisitions).set({ status: "closed" }).where(eq(requisitions.id, r));
    expect(await dist.reconcileGoogleListings(orgA)).toEqual({ listed: 0, unlisted: 1 });
    n = await notices();
    expect(n.map((x) => [x.kind, x.status])).toEqual([["URL_DELETED", "pending"]]);

    // Switching Google off takes every listed role down.
    const r2 = await role(orgA);
    await dist.reconcileGoogleListings(orgA);
    await dist.setGoogleJobs(orgA, actor(), false);
    n = await notices();
    expect(n.find((x) => x.requisitionId === r2)!.kind).toBe("URL_DELETED");
  });

  test("the queue is sent within the daily quota, signed with the service account", async () => {
    const r1 = await role(orgA);
    const r2 = await role(orgA);
    const r3 = await role(orgA);
    await dist.setGoogleJobs(orgA, actor(), true);
    const calls: { url: string; body: string; auth: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
      if (url.includes("oauth2.googleapis.com"))
        return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json({ urlNotificationMetadata: {} });
    }) as typeof fetch;
    env.GOOGLE_INDEXING_DAILY_LIMIT = (await indexing.sentToday()) + 2;
    const run = await indexing.processIndexQueue();
    expect(run).toMatchObject({ configured: true, sent: 2, stopped: null });
    const assertion = new URLSearchParams(calls[0]!.body).get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "indexer@test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/indexing",
    });
    expect(calls[1]).toMatchObject({ auth: "Bearer tok" });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ type: "URL_UPDATED" });

    // The quota is used up: nothing more today.
    expect(await indexing.processIndexQueue()).toMatchObject({ sent: 0, stopped: "quota" });
    const left = await db
      .select()
      .from(jobIndexNotifications)
      .where(
        and(eq(jobIndexNotifications.orgId, orgA), eq(jobIndexNotifications.status, "pending")),
      );
    expect(left).toHaveLength(1);
    expect([r1, r2, r3]).toContain(left[0]!.requisitionId!);
  });

  test("errors are retried three times; a slow-down stops the pass; stale notices expire", async () => {
    await role(orgA);
    await dist.setGoogleJobs(orgA, actor(), true);
    env.GOOGLE_INDEXING_DAILY_LIMIT = (await indexing.sentToday()) + 50;
    let answer = 403;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes("oauth2")
        ? Response.json({ access_token: "tok", expires_in: 3600 })
        : new Response("Permission denied", { status: answer })) as typeof fetch;
    for (let i = 0; i < 3; i++) await indexing.processIndexQueue();
    const [failed] = await db
      .select()
      .from(jobIndexNotifications)
      .where(eq(jobIndexNotifications.orgId, orgA));
    expect(failed).toMatchObject({ status: "failed", attempts: 3 });
    expect(failed!.lastError).toMatch(/403: Permission denied/);

    await role(orgA);
    await dist.reconcileGoogleListings(orgA);
    answer = 429;
    expect(await indexing.processIndexQueue()).toMatchObject({ stopped: "rate_limited", sent: 0 });

    await db
      .update(jobIndexNotifications)
      .set({ createdAt: new Date(Date.now() - 4 * 86_400_000) })
      .where(
        and(eq(jobIndexNotifications.orgId, orgA), eq(jobIndexNotifications.status, "pending")),
      );
    expect((await indexing.processIndexQueue()).expired).toBeGreaterThanOrEqual(1);
  });

  test("without the credential nothing is sent", async () => {
    const saved = env.GOOGLE_INDEXING_CREDENTIALS;
    env.GOOGLE_INDEXING_CREDENTIALS = undefined;
    try {
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("");
      }) as unknown as typeof fetch;
      await role(orgA);
      await dist.setGoogleJobs(orgA, actor(), true);
      expect(await indexing.processIndexQueue()).toMatchObject({ configured: false, sent: 0 });
      expect(called).toBe(false);
      expect(indexing.indexingAccount("not json")).toBeNull();
      expect(
        indexing.indexingAccount(
          Buffer.from(JSON.stringify({ client_email: "a@b", private_key: "k" })).toString("base64"),
        ),
      ).toEqual({ client_email: "a@b", private_key: "k" });
    } finally {
      env.GOOGLE_INDEXING_CREDENTIALS = saved;
    }
  });
});

/* ----------------------------------------------------- applicants and report */

describe("applicants are counted against the right channel", () => {
  test("the apply page records the link's source, and only a known one", async () => {
    const r = await role(orgA);
    const base = {
      requisitionId: r,
      fileName: "cv.pdf",
      resumeText: "Engineer with ten years of building distributed systems and platforms.",
      fullName: "Asha",
      phone: null,
    };
    await submitApplicationImpl({ ...base, email: `a-${stamp}@test.local`, source: "jooble" });
    await submitApplicationImpl({ ...base, email: `b-${stamp}@test.local`, source: "evil_source" });
    await submitApplicationImpl({
      ...base,
      email: `c-${stamp}@test.local`,
      source: null,
      utmSource: "google_jobs_apply",
    });
    const rows = await db
      .select({ source: applications.source })
      .from(applications)
      .where(eq(applications.requisitionId, r));
    expect(rows.map((x) => x.source).sort()).toEqual(["careers_site", "google_jobs", "jooble"]);
  });

  test("the report counts how far each channel's applicants got, per organisation", async () => {
    const r = await role(orgA);
    const other = await role(orgB);
    await dist.addToFeed(orgA, actor(), r, "jooble");
    const add = async (
      orgId: string,
      req: string,
      source: string,
      stage: string,
      events: string[] = [],
    ) => {
      const [c] = await db
        .insert(candidates)
        .values({ orgId, fullName: "X", email: `${Math.random()}@t.local`, source } as never)
        .returning({ id: candidates.id });
      const [a] = await db
        .insert(applications)
        .values({ orgId, requisitionId: req, candidateId: c!.id, source, stage } as never)
        .returning({ id: applications.id });
      for (const to of events)
        await db.insert(stageEvents).values({ orgId, applicationId: a!.id, toStage: to } as never);
    };
    await add(orgA, r, "jooble", "applied");
    await add(orgA, r, "jooble", "rejected", ["shortlisted", "l1"]);
    await add(orgA, r, "jooble", "joined", ["shortlisted", "l1", "offer_released", "hired"]);
    await add(orgA, r, "internshala", "shortlisted");
    await add(orgB, other, "jooble", "hired");
    const report = await dist.channelReport(orgA, 90);
    expect(report.find((x) => x.source === "jooble")).toEqual({
      source: "jooble",
      applicants: 3,
      shortlisted: 2,
      interviewed: 2,
      offered: 1,
      hired: 1,
      liveRoles: 1,
    });
    expect(report.find((x) => x.source === "internshala")).toMatchObject({
      applicants: 1,
      shortlisted: 1,
      interviewed: 0,
      liveRoles: 0,
    });
  });
});
