/**
 * Org-domain behaviour lockdown (Phase 4 prep), against the disposable
 * database. Everything here tests the exported, invocable cores of the "org"
 * domain — the *.functions.ts server fns themselves are requireOrg-wrapped
 * and not invocable from bun test, so what is locked down is the core each
 * wrapper delegates to:
 *  - integrations.server.ts: the generic credential store round-trips through
 *    encryptSecret, merges (an empty patch value preserves the stored secret),
 *    upserts idempotently, never stores plaintext and is keyed on
 *    integrationId ALONE (no org predicate — the caller's
 *    eq(sourceIntegrations.orgId) ownership lookup is the tenant boundary;
 *    a Phase 4 move must not change that asymmetry silently);
 *  - assertIntegrationBaseUrl: https + allow-listed partner host (suffix
 *    match), no credentials-in-URL, trailing slash stripped;
 *  - importFromProvider / testProvider refusal paths (careers/github are not
 *    searchable, unconfigured providers refuse, non-2xx / non-JSON bodies
 *    become vendor-neutral errors, happy mapping falls back per field);
 *  - templates.server.ts: resolveTemplate is org-scoped (a foreign org's
 *    templateId resolves to null), explicit id beats the org default, a
 *    config failing its zod schema degrades to null (never throws);
 *    buildTemplateSystemPrompt order and stripUnreplacedPlaceholders;
 *  - integration-seeds.server.ts: the 8-provider catalog lands scoped to the
 *    org, disabled, and is idempotent;
 *  - org-setup.server.ts: uniqueInboxSlug derives from the domain, falls back
 *    to the name, and appends -2 past a global collision;
 *  - org.functions.ts inviteMemberCore refusals: inactive org, personal
 *    mailbox, owner-domain mismatch, duplicate roster email; a pass leaves an
 *    invited roster row with invitedRole plus the member.invited audit.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… SECRET_ENCRYPTION_KEY=… bun test scripts/org-domain.test.ts
 */
// bun test does not load .env.local — pick up the secrets the server env
// schema demands (SESSION_SECRET et al) before any module graph loads, so the
// documented run line needs only DATABASE_URL.
import { readFileSync } from "node:fs";
try {
  const dotEnv = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of dotEnv.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !m[1]!.startsWith("DATABASE_URL") && process.env[m[1]!] === undefined)
      process.env[m[1]!] = m[2]!;
  }
} catch {
  // no .env.local — the caller must have exported everything.
}
process.env["SECRET_ENCRYPTION_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const {
  auditLog,
  contentTemplates,
  integrationCredentials,
  orgMembers,
  organizations,
  sourceIntegrations,
  users,
} = await import("../drizzle/schema");
const integ = await import("../src/lib/integrations.server");
const seeds = await import("../src/server/integration-seeds.server");
const setup = await import("../src/server/org-setup.server");
const tpl = await import("../src/lib/templates.server");
const { inviteMemberCore } = await import("../src/lib/org.functions");

const stamp = Date.now();
const dom = `orgd${stamp}.test`;
let orgA: string;
let orgB: string;
let orgInactive: string;
let ownerId: string;
let aNaukri: string;
let bNaukri: string;
let slugCollisionOrg: string;

async function mkOrg(name: string, status = "active", inboxSlug?: string) {
  return (
    await db
      .insert(organizations)
      .values({ name, slug: `${name}-${stamp}`, status, inboxSlug })
      .returning({ id: organizations.id })
  )[0]!.id;
}
async function mkUser(email: string) {
  return (await db.insert(users).values({ email }).returning({ id: users.id }))[0]!.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = await mkOrg(`Org Domain A`);
  orgB = await mkOrg(`Org Domain B`);
  orgInactive = await mkOrg(`Org Domain Pending`, "pending");
  ownerId = await mkUser(`owner@${dom}`);
  await db.insert(orgMembers).values({
    orgId: orgA,
    userId: ownerId,
    email: `owner@${dom}`,
    fullName: "Domain Owner",
    status: "active",
    isOwner: true,
  } as never);
  await seeds.seedSourceIntegrations(orgA);
  await seeds.seedSourceIntegrations(orgB);
  const rows = await db
    .select({
      id: sourceIntegrations.id,
      orgId: sourceIntegrations.orgId,
      provider: sourceIntegrations.provider,
    })
    .from(sourceIntegrations);
  aNaukri = rows.find((r) => r.orgId === orgA && r.provider === "naukri")!.id;
  bNaukri = rows.find((r) => r.orgId === orgB && r.provider === "naukri")!.id;
});

afterAll(async () => {
  // audit rows carry no FK; the rest cascades from organizations.
  for (const id of [orgA, orgB, orgInactive])
    await db.delete(auditLog).where(eq(auditLog.orgId, id));
  await db.delete(organizations).where(eq(organizations.id, orgA));
  await db.delete(organizations).where(eq(organizations.id, orgB));
  await db.delete(organizations).where(eq(organizations.id, orgInactive));
  if (slugCollisionOrg)
    await db.delete(organizations).where(eq(organizations.id, slugCollisionOrg));
  await db.delete(users).where(eq(users.id, ownerId));
});

describe("assertIntegrationBaseUrl", () => {
  test("rejects a non-URL and a non-https base", () => {
    expect(() => integ.assertIntegrationBaseUrl("not a url")).toThrow("not a valid URL");
    expect(() => integ.assertIntegrationBaseUrl("http://api.naukri.com")).toThrow("must use https");
  });

  test("rejects a host outside the partner allow-list, allows suffix matches", () => {
    expect(() => integ.assertIntegrationBaseUrl(`https://evil-${stamp}.example/x`)).toThrow(
      "not an approved partner endpoint",
    );
    expect(integ.assertIntegrationBaseUrl("https://api.naukri.com/")).toBe(
      "https://api.naukri.com",
    );
    // suffix match: a subdomain of an approved host is fine.
    expect(integ.assertIntegrationBaseUrl(`https://api.partner.api.naukri.com/v2`)).toContain(
      "api.partner.api.naukri.com",
    );
  });

  test("rejects credentials embedded in the URL", () => {
    expect(() => integ.assertIntegrationBaseUrl("https://user:pass@api.naukri.com")).toThrow(
      "Credentials in URLs are not allowed",
    );
  });
});

describe("the generic credential store (readSecrets/writeSecrets/clearSecrets)", () => {
  test("write then read round-trips through encryption, never plaintext at rest", async () => {
    await integ.writeSecrets(aNaukri, {
      client_id: `cid-${stamp}`,
      client_secret: `topsecret-${stamp}`,
    });
    const read = await integ.readSecrets(aNaukri);
    expect(read.client_id).toBe(`cid-${stamp}`);
    expect(read.client_secret).toBe(`topsecret-${stamp}`);

    const [raw] = await db
      .select({ secrets: integrationCredentials.secrets })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, aNaukri));
    expect(JSON.stringify(raw!.secrets)).not.toContain(`topsecret-${stamp}`);
  });

  test("an empty patch value leaves the stored secret alone; new keys merge in", async () => {
    await integ.writeSecrets(aNaukri, { account_id: `acc-${stamp}`, client_secret: "" });
    const read = await integ.readSecrets(aNaukri);
    expect(read.account_id).toBe(`acc-${stamp}`);
    expect(read.client_secret).toBe(`topsecret-${stamp}`);
    expect(read.client_id).toBe(`cid-${stamp}`);
  });

  test("the upsert is idempotent — one row per integration", async () => {
    await integ.writeSecrets(aNaukri, { client_id: `cid-${stamp}` });
    const mine = await db
      .select({ id: integrationCredentials.integrationId })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, aNaukri));
    expect(mine.length).toBe(1);
  });

  test("keys on integrationId alone: another org's integration never leaks in", async () => {
    await integ.writeSecrets(bNaukri, { client_id: `other-org-${stamp}` });
    const a = await integ.readSecrets(aNaukri);
    const b = await integ.readSecrets(bNaukri);
    expect(b.client_id).toBe(`other-org-${stamp}`);
    expect(a.client_id).toBe(`cid-${stamp}`);
    expect(JSON.stringify(a)).not.toContain(`other-org-${stamp}`);
  });

  test("clearSecrets removes the row entirely", async () => {
    await integ.clearSecrets(bNaukri);
    expect(await integ.readSecrets(bNaukri)).toEqual({});
    const rows = await db
      .select({ id: integrationCredentials.integrationId })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, bNaukri));
    expect(rows.length).toBe(0);
  });
});

describe("importFromProvider / testProvider refusals", () => {
  const base = {
    keywords: ["platform"],
    experienceMin: 3,
    experienceMax: 9,
    location: "Bengaluru",
    limit: 10,
  };

  test("careers and github are not searchable resume databases", async () => {
    for (const provider of ["careers", "github"] as const)
      await expect(
        integ.importFromProvider({
          ...base,
          provider,
          secrets: { token: "t" },
          config: { base_url: "https://api.github.com" },
        }),
      ).rejects.toThrow("not a searchable resume database");
  });

  test("an unconfigured provider refuses before any fetch", async () => {
    await expect(
      integ.importFromProvider({ ...base, provider: "naukri", secrets: {}, config: {} }),
    ).rejects.toThrow("not fully configured");
    await expect(
      integ.importFromProvider({
        ...base,
        provider: "naukri",
        secrets: { client_id: "c", client_secret: "s" },
        config: {},
      }),
    ).rejects.toThrow("not fully configured");
  });

  test("a non-2xx partner answer becomes a vendor-neutral error", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    try {
      await expect(
        integ.importFromProvider({
          ...base,
          provider: "naukri",
          secrets: { access_token: "t" },
          config: { base_url: "https://api.naukri.com" },
        }),
      ).rejects.toThrow("naukri search failed [500]");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a non-JSON partner answer is refused", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>502</html>", { status: 200 })) as typeof fetch;
    try {
      await expect(
        integ.importFromProvider({
          ...base,
          provider: "naukri",
          secrets: { access_token: "t" },
          config: { base_url: "https://api.naukri.com" },
        }),
      ).rejects.toThrow("non-JSON response");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("the happy path maps the payload with per-field fallbacks", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { id: "p1", name: "Asha Rao", email: "a@x.io", experience_years: 7, skills: ["LLMs"] },
            { candidate_id: "p2", full_name: "Bo Kiran", total_experience: "4" },
            { uuid: "p3" },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const out = await integ.importFromProvider({
        ...base,
        provider: "naukri",
        secrets: { api_key: "t" },
        config: { base_url: "https://api.naukri.com" },
      });
      // id → candidate_id → a fresh random UUID (a bare `uuid` field is ignored).
      expect(out[0]!.external_id).toBe("p1");
      expect(out[1]!.external_id).toBe("p2");
      expect(out[2]!.external_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(out[0]).toMatchObject({
        full_name: "Asha Rao",
        experience_years: 7,
        skills: ["LLMs"],
      });
      expect(out[1]).toMatchObject({ full_name: "Bo Kiran", experience_years: 4 });
      expect(out[2]!.full_name).toBe("Unknown");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("testProvider: missing credentials are pending, careers needs nothing, linkedin is panel-managed", async () => {
    const missing = await integ.testProvider("naukri", {}, {});
    expect(missing.status).toBe("pending");
    expect(missing.message).toContain("client_id");
    const careers = await integ.testProvider("careers", {}, {});
    expect(careers.status).toBe("ok");
    const linkedin = await integ.testProvider("linkedin", {}, {});
    expect(linkedin.status).toBe("ok");
    expect(linkedin.message).toContain("LinkedIn");
  });
});

describe("template resolution (templates.server)", () => {
  let defaultJd: string;
  let pinnedJd: string;
  let badPost: string;
  let bJd: string;

  beforeAll(async () => {
    defaultJd = (
      await db
        .insert(contentTemplates)
        .values({
          orgId: orgA,
          kind: "jd",
          name: `default-jd-${stamp}`,
          isDefault: true,
          config: {
            sections: [
              { key: "about", heading: "About us" },
              { key: "resp", heading: "Responsibilities" },
            ],
            boilerplate: "We are an equal-opportunity employer.",
          },
          instructions: "Never mention relocation.",
        })
        .returning({ id: contentTemplates.id })
    )[0]!.id;
    pinnedJd = (
      await db
        .insert(contentTemplates)
        .values({
          orgId: orgA,
          kind: "jd",
          name: `pinned-jd-${stamp}`,
          isDefault: false,
          config: { sections: [{ key: "about", heading: "Who we are" }], boilerplate: null },
          instructions: null,
        })
        .returning({ id: contentTemplates.id })
    )[0]!.id;
    badPost = (
      await db
        .insert(contentTemplates)
        .values({
          orgId: orgA,
          kind: "linkedin_post",
          name: `bad-post-${stamp}`,
          isDefault: false,
          // 11 mustInclude lines exceeds the schema's max of 10 → corrupt row.
          config: { mustInclude: Array.from({ length: 11 }, (_, i) => `line ${i}`) },
        })
        .returning({ id: contentTemplates.id })
    )[0]!.id;
    bJd = (
      await db
        .insert(contentTemplates)
        .values({
          orgId: orgB,
          kind: "jd",
          name: `org-b-jd-${stamp}`,
          isDefault: true,
          config: { sections: [{ key: "about", heading: "Org B only" }] },
        })
        .returning({ id: contentTemplates.id })
    )[0]!.id;
  });

  test("an explicit templateId wins over the org's default", async () => {
    const t = await tpl.resolveTemplate(orgA, "jd", pinnedJd);
    expect(t).toMatchObject({ id: pinnedJd, name: `pinned-jd-${stamp}` });
    expect(t!.config.sections[0]!.heading).toBe("Who we are");
  });

  test("with no pinned id the org's default resolves", async () => {
    const t = await tpl.resolveTemplate(orgA, "jd", null);
    expect(t!.id).toBe(defaultJd);
    expect(t!.instructions).toBe("Never mention relocation.");
  });

  test("a foreign org's templateId resolves to null — no cross-org read", async () => {
    expect(await tpl.resolveTemplate(orgA, "jd", bJd)).toBeNull();
    expect(await tpl.resolveTemplate(orgB, "jd", defaultJd)).toBeNull();
  });

  test("a config failing its zod schema degrades to null, never throws", async () => {
    expect(await tpl.resolveTemplate(orgA, "linkedin_post", badPost)).toBeNull();
  });

  test("an org with no template of the kind resolves to null", async () => {
    expect(await tpl.resolveTemplate(orgB, "offer_letter", null)).toBeNull();
  });

  test("buildTemplateSystemPrompt layers config, then instructions, then the placeholder contract", async () => {
    const t = (await tpl.resolveTemplate(orgA, "jd", null))!;
    const prompt = tpl.buildTemplateSystemPrompt({ base: "BUILTIN RULES", template: t });
    expect(prompt.startsWith("BUILTIN RULES")).toBe(true);
    expect(prompt).toContain("About us → Responsibilities");
    expect(prompt).toContain("We are an equal-opportunity employer.");
    expect(prompt).toContain("Never mention relocation.");
    expect(prompt.indexOf("Never mention relocation.")).toBeLessThan(
      prompt.indexOf("Placeholders you may use"),
    );
    expect(prompt.trim().endsWith("{{salary}}")).not.toBe(true);
    expect(prompt).toContain("{{role}}");

    expect(tpl.buildTemplateSystemPrompt({ base: "BUILTIN RULES", template: null })).toBe(
      "BUILTIN RULES",
    );
  });

  test("stripUnreplacedPlaceholders removes unfilled slots and the debris", () => {
    expect(tpl.stripUnreplacedPlaceholders("Pay: {{salary}} () Name: {{ name }}  end")).toBe(
      "Pay: Name: end",
    );
  });

  afterAll(async () => {
    await db.delete(contentTemplates).where(eq(contentTemplates.orgId, orgB));
    await db
      .delete(contentTemplates)
      .where(and(eq(contentTemplates.orgId, orgA), eq(contentTemplates.kind, "jd")));
    await db
      .delete(contentTemplates)
      .where(and(eq(contentTemplates.orgId, orgA), eq(contentTemplates.kind, "linkedin_post")));
  });
});

describe("integration seeding (integration-seeds.server)", () => {
  test("seeds the full catalog for the org, all disabled", async () => {
    const rows = await db
      .select({
        provider: sourceIntegrations.provider,
        enabled: sourceIntegrations.enabled,
        credentialFields: sourceIntegrations.credentialFields,
      })
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.orgId, orgA));
    expect(rows.length).toBe(seeds.INTEGRATION_CATALOG.length);
    expect(new Set(rows.map((r) => r.provider))).toEqual(
      new Set(seeds.INTEGRATION_CATALOG.map((p) => p.provider)),
    );
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    const zoom = rows.find((r) => r.provider === "zoom");
    expect(zoom!.credentialFields).toEqual(["account_id", "client_id", "client_secret"]);
  });

  test("re-seeding is a no-op (onConflictDoNothing)", async () => {
    await seeds.seedSourceIntegrations(orgA);
    const rows = await db
      .select({ id: sourceIntegrations.id })
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.orgId, orgA));
    expect(rows.length).toBe(seeds.INTEGRATION_CATALOG.length);
  });

  test("org B's catalog is separate — org A's rows untouched", async () => {
    const b = await db
      .select({ provider: sourceIntegrations.provider })
      .from(sourceIntegrations)
      .where(eq(sourceIntegrations.orgId, orgB));
    expect(b.length).toBe(seeds.INTEGRATION_CATALOG.length);
  });
});

describe("uniqueInboxSlug (org-setup.server)", () => {
  test("derives the slug from the company domain, normalising to '-'", async () => {
    // Real callers pass the (already lowercased) owner email domain.
    expect(await setup.uniqueInboxSlug(`acme${stamp}.co.in`, "Acme Systems")).toBe(`acme${stamp}`);
    expect(await setup.uniqueInboxSlug(`acme-team${stamp}.test`, "X")).toBe(`acme-team${stamp}`);
    // Issue #92: an upper-case first label must lowercase, not turn into a
    // leading dash via the [^a-z0-9-] replace.
    expect(await setup.uniqueInboxSlug(`Acme${stamp}.co.in`, "Acme Systems")).toBe(`acme${stamp}`);
    expect(await setup.uniqueInboxSlug(`MixedCase-Team${stamp}.test`, "X")).toBe(
      `mixedcase-team${stamp}`,
    );
  });

  test("falls back to the org name when the domain gives nothing", async () => {
    expect(await setup.uniqueInboxSlug("", "Acme Health Systems")).toBe("acme-health-systems");
  });

  test("appends -2 past a global collision (ilike, any case)", async () => {
    slugCollisionOrg = await mkOrg("Org Slug Collision", "active", `slugcol${stamp}`);
    expect(await setup.uniqueInboxSlug(`slugcol${stamp}.test`, "X")).toBe(`slugcol${stamp}-2`);
  });
});

describe("inviteMemberCore refusals (org.functions)", () => {
  test("an unapproved organisation refuses the invite", async () => {
    expect(
      inviteMemberCore(orgInactive, ownerId, {
        email: `new@${dom}`,
        role: "recruiter",
        title: "",
        fullName: "New Person",
      }),
    ).rejects.toThrow("not approved yet");
  });

  test("a personal mailbox domain is refused", async () => {
    expect(
      inviteMemberCore(orgA, ownerId, {
        email: "someone@gmail.com",
        role: "recruiter",
        title: "",
        fullName: "Some One",
      }),
    ).rejects.toThrow("personal mailbox provider");
  });

  test("an invitee outside the owner's registrable domain is refused, domain named", async () => {
    const other = `other-${stamp}.test`;
    await expect(
      inviteMemberCore(orgA, ownerId, {
        email: `someone@${other}`,
        role: "recruiter",
        title: "",
        fullName: "Some One",
      }),
    ).rejects.toThrow(dom);
  });

  test("an email already on the roster is refused", async () => {
    await expect(
      inviteMemberCore(orgA, ownerId, {
        email: `owner@${dom}`,
        role: "recruiter",
        title: "",
        fullName: "Dup",
      }),
    ).rejects.toThrow("already on the roster");
  });

  test("a valid invite lands as an invited roster row with invitedRole and the member.invited audit", async () => {
    expect(
      await inviteMemberCore(orgA, ownerId, {
        email: `invited-${stamp}@${dom}`,
        role: "president_cbo",
        title: "CBO",
        fullName: "In Vited",
      }),
    ).toEqual({ ok: true, notified: true });
    const [row] = await db
      .select({
        status: orgMembers.status,
        invitedRole: orgMembers.invitedRole,
        invitedBy: orgMembers.invitedBy,
      })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgA), eq(orgMembers.email, `invited-${stamp}@${dom}`)));
    expect(row).toMatchObject({
      status: "invited",
      invitedRole: "president_cbo",
      invitedBy: ownerId,
    });
    const audits = await db
      .select({ action: auditLog.action, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "member.invited")));
    expect(audits.length).toBe(1);
    expect(audits[0]!.detail).toMatchObject({
      email: `invited-${stamp}@${dom}`,
      role: "president_cbo",
    });
  });
});
