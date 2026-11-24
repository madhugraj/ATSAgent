/**
 * Legal domain behaviour lockdown (pre-@ats/* package extraction):
 *  - the static documents keep their shape (titled sections, dated versions)
 *    and never name an AI vendor or model;
 *  - the pure helpers behave as documented: formatVersionDate renders in UTC
 *    and passes junk through, outstandingAgreements matches on kind AND
 *    version so an older accepted generation goes outstanding on a bump;
 *  - assertCurrentVersions refuses a stale version of every kind with the
 *    reload message, and hashIp fails open to no-hash without a secret;
 *  - the wire layer keeps its gates: myOrgAgreements is panel-admitting
 *    (panel-only members may read, by design), acceptOrgAgreements is owner
 *    only, and the intentionally unbounded platform listing stays behind
 *    requirePlatformAdmin — none of the returns leak model/engine fields and
 *    the only audit-writing path stays recordAgreementAcceptance.
 * Run: DATABASE_URL=postgres://…/atsagent_test bun test scripts/legal-domain.test.ts
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { orgMembers, organizations, userRoles, users } = await import("../drizzle/schema");
const auth = await import("../src/lib/auth.middleware");
const legal = await import("../src/lib/legal/agreements");
const { DPA_SECTIONS } = await import("../src/lib/legal/dpa");
const { PRIVACY_SECTIONS } = await import("../src/lib/legal/privacy");
const { TERMS_SECTIONS } = await import("../src/lib/legal/terms");
const core = await import("../src/server/org-agreements.server");

const stamp = Date.now();
const domain = `lega${stamp}.test`;
let orgId: string;
let ownerId: string;
let panelOnlyId: string;
let memberId: string;

async function user(email: string) {
  return (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
}
async function member(userId: string, email: string, isOwner = false) {
  await db.insert(orgMembers).values({ orgId, userId, email, status: "active", isOwner } as never);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Legal Org", slug: `lega-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
  ownerId = await user(`owner@${domain}`);
  panelOnlyId = await user(`panel@${domain}`);
  memberId = await user(`member@${domain}`);
  await member(ownerId, `owner@${domain}`, true);
  await member(panelOnlyId, `panel@${domain}`);
  await member(memberId, `member@${domain}`);
  await db.insert(userRoles).values([
    { userId: panelOnlyId, orgId, role: "interviewer" as never },
    { userId: memberId, orgId, role: "recruiter" as never },
  ]);
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const id of [ownerId, panelOnlyId, memberId]) await db.delete(users).where(eq(users.id, id));
});

/* ------------------------------------------------------ static content */

describe("the documents", () => {
  const VENDOR =
    /\b(openai|anthropic|claude|gpt-?\d|gemini|google ai|mistral|llama|cohere|deepseek|vertex|bedrock|groq|qwen|grok)\b/i;

  test("each document is a non-empty list of titled sections, versioned by date", () => {
    const sectionsOf = { terms: TERMS_SECTIONS, privacy: PRIVACY_SECTIONS, dpa: DPA_SECTIONS };
    for (const kind of legal.AGREEMENT_KINDS) {
      const doc = legal.AGREEMENTS[kind];
      expect(doc.kind).toBe(kind);
      expect(doc.path).toBe(`/${kind}`);
      expect(doc.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.intro.length).toBeGreaterThan(0);
      expect(typeof doc.draft).toBe("boolean");
      expect(doc.sections).toBe(sectionsOf[kind]);
      const sections = doc.sections;
      expect(sections.length).toBeGreaterThan(0);
      for (const s of sections) {
        expect(typeof s.title).toBe("string");
        expect(s.title.length).toBeGreaterThan(0);
        expect(Array.isArray(s.body)).toBe(true);
        expect(s.body.length).toBeGreaterThan(0);
        for (const p of s.body) expect(typeof p).toBe("string");
      }
    }
    expect(legal.currentAgreementVersions()).toEqual({
      terms: legal.AGREEMENTS.terms.version,
      privacy: legal.AGREEMENTS.privacy.version,
      dpa: legal.AGREEMENTS.dpa.version,
    });
  });

  test("the legal text never names an AI vendor or model", () => {
    const text = legal.AGREEMENT_KINDS.map((kind) => {
      const doc = legal.AGREEMENTS[kind];
      return [doc.title, doc.intro, ...doc.sections.flatMap((s) => [s.title, ...s.body])].join(
        "\n",
      );
    }).join("\n");
    expect(text).not.toMatch(VENDOR);
  });
});

/* ------------------------------------------------------- pure helpers */

describe("pure helpers", () => {
  test("formatVersionDate renders in UTC and passes non-dates through", () => {
    expect(legal.formatVersionDate("2026-10-27")).toBe("27 October 2026");
    expect(legal.formatVersionDate("not-a-date")).toBe("not-a-date");
    expect(legal.formatVersionDate("2026-13-45")).toBe("2026-13-45");
  });

  test("outstandingAgreements matches on kind AND version", () => {
    const old = { terms: "2020-01-01", privacy: "2020-01-01", dpa: "2020-01-01" };
    const next = { terms: "2026-01-01", privacy: "2026-01-01", dpa: "2026-01-01" };
    // An org that accepted a whole older generation is outstanding on all
    // three once `current` is bumped — one call, multi-kind staleness.
    const acceptedOlder = (Object.keys(old) as (keyof typeof old)[]).map((k) => ({
      kind: k,
      version: old[k],
    }));
    expect(legal.outstandingAgreements(acceptedOlder, next)).toEqual(["terms", "privacy", "dpa"]);
    // Accepting terms at the old version does not satisfy the new one.
    expect(legal.outstandingAgreements([{ kind: "terms", version: old.terms }], next)).toContain(
      "terms",
    );
    expect(
      legal.outstandingAgreements([{ kind: "terms", version: next.terms }], next),
    ).not.toContain("terms");
  });
});

/* ------------------------------------------------------ server guards */

describe("server guards", () => {
  test("a stale version of any kind is refused with the reload message", () => {
    const current = { terms: "2026-01-01", privacy: "2026-02-02", dpa: "2026-03-03" };
    const message = /updated after you opened them/;
    for (const kind of legal.AGREEMENT_KINDS)
      expect(() =>
        core.assertCurrentVersions({ ...current, [kind]: "1999-09-09" }, current),
      ).toThrow(message);
    expect(() => core.assertCurrentVersions(current, current)).not.toThrow();
  });

  test("hashIp fails open to no-hash when SESSION_SECRET is unset", () => {
    const had = process.env["SESSION_SECRET"];
    delete process.env["SESSION_SECRET"];
    try {
      expect(core.hashIp("203.0.113.9")).toBeNull();
      expect(core.hashIp("unknown")).toBeNull();
      expect(core.hashIp(null)).toBeNull();
    } finally {
      if (had !== undefined) process.env["SESSION_SECRET"] = had;
    }
  });
});

/* --------------------------------------------------------- role gates */

describe("role gates", () => {
  test("myOrgAgreements admits a panel-only member to read, but they cannot accept", async () => {
    const viaPanel = await auth.activeOrgOf(panelOnlyId, { allowPanel: true });
    expect(viaPanel).toMatchObject({ orgId, panelOnly: true, isOwner: false });
    // The same member resolves to no organisation for the owner gate.
    expect(await auth.activeOrgOf(panelOnlyId)).toBeNull();
    await expect(auth.assertRole(panelOnlyId, orgId, "recruiter")).rejects.toThrow();
  });

  test("acceptOrgAgreements is refused for every non-owner, allowed for the owner", async () => {
    // The owner gate reads membership.isOwner off activeOrgOf — a plain
    // member and a panel-only member both fail it, the owner passes.
    const plain = await auth.activeOrgOf(memberId);
    expect(plain).toMatchObject({ orgId, isOwner: false, panelOnly: false });
    expect(await auth.activeOrgOf(ownerId)).toMatchObject({ orgId, isOwner: true });
    const src = readFileSync("src/lib/org-agreements.functions.ts", "utf8");
    const accept = src.slice(src.indexOf("export const acceptOrgAgreements"));
    expect(accept.slice(0, 200)).toContain(".middleware([requireOrgOwner])");
  });
});

/* --------------------------------------------------- wire-layer source */

describe("wire layer", () => {
  test("the agreement functions keep their gates and vendor-neutral returns", () => {
    const src = readFileSync("src/lib/org-agreements.functions.ts", "utf8");
    expect(src.match(/createServerFn\(/g)?.length).toBe(2);
    const mine = src.slice(src.indexOf("export const myOrgAgreements"));
    // Intentional deviation from the every-tenant-fn-uses-requireOrg
    // invariant: panel-only members pass through the same workspace gate.
    expect(mine.slice(0, 200)).toContain(".middleware([requirePanel])");
    expect(mine).toContain("orgAgreementStatus(context.orgId)");
    expect(mine).toContain("lastAcceptedAt: status.history[0]?.acceptedAt ?? null");
    // No client-accepted status/trail logic and no weaker gate anywhere.
    expect(src).not.toMatch(/assertRole\(|requireOrg\b|requireRole\(/);
    // No vendor or model internals on the wire.
    expect(src).not.toMatch(/\b(model|engine|vendor)\s*:/i);
    // The audit stays in the core, so both entry points are audited.
    const serverSrc = readFileSync("src/server/org-agreements.server.ts", "utf8");
    expect(serverSrc.match(/writeAudit\(/g)?.length).toBe(1);
    expect(serverSrc.indexOf("writeAudit(")).toBeGreaterThan(
      serverSrc.indexOf("export async function recordAgreementAcceptance"),
    );
  });

  test("the unbounded platform listing is reachable only through requirePlatformAdmin", () => {
    const src = readFileSync("src/lib/platform.functions.ts", "utf8");
    const fn = src.slice(src.indexOf("export const listOrgAgreementsAsSuperUser"));
    expect(fn.slice(0, 200)).toContain(".middleware([requirePlatformAdmin])");
  });
});
