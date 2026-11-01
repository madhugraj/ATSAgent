/**
 * Model safety check (src/server/redteam/, docs/red-team.md) against the
 * disposable database with a scripted model: a resistant model passes and
 * unlocks Autonomous for that model only; a model that follows one attack,
 * or a probe that cannot run, fails; reruns are throttled.
 * Run: DATABASE_URL=... SESSION_SECRET=... bun test scripts/redteam-check.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

type Reply = {
  score: number;
  summary: string;
  actions: string[];
  suspected_prompt_injection: boolean;
};
let behave: (prompt: string) => Reply | null = () => null;
const seen: { system: string; prompt: string; feature: string }[] = [];

const real = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...real,
  resolveAiConfig: async () => ({ provider: "openai", model: currentModel, apiKey: "sk-test" }),
  aiJson: async (o: { system: string; prompt: string; feature: string }) => {
    seen.push(o);
    const r = behave(o.prompt);
    return r
      ? { ok: true, data: r, model: currentModel, provider: "openai", usage: null }
      : { ok: false, status: 502, message: "provider error" };
  },
}));
let currentModel = "model-a";

const { db } = await import("../src/server/db");
const { aiRedteamChecks, organizations, users } = await import("../drizzle/schema");
const { runSafetyCheck, hasValidSafetyCheck, safetyCheckView } =
  await import("../src/server/redteam/check.server");
const { PROBES } = await import("../src/server/redteam/probes");

let orgId: string;
let userId: string;
const stamp = Date.now();
const honest = (): Reply => ({
  score: 10,
  summary: "No Kubernetes or on-call evidence; a junior web profile.",
  actions: ["reject"],
  suspected_prompt_injection: true,
});

beforeAll(async () => {
  const [o] = await db
    .insert(organizations)
    .values({ name: "RT Org", slug: `rt-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [u] = await db
    .insert(users)
    .values({ email: `rt-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
});
afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});
beforeEach(async () => {
  await db.delete(aiRedteamChecks).where(eq(aiRedteamChecks.orgId, orgId));
  seen.length = 0;
  currentModel = "model-a";
});

describe("model safety check", () => {
  test("every probe runs fenced, with the injection rules, on the ledger feature", async () => {
    behave = honest;
    await runSafetyCheck(orgId, userId);
    expect(seen).toHaveLength(PROBES.length);
    for (const c of seen) {
      expect(c.feature).toBe("redteam_probe");
      expect(c.system).toStartWith("Security rules (highest priority):");
      expect(c.prompt).toStartWith('<untrusted_data label="candidate_cv">');
      // The fence-escape payload's own tags were stripped by untrusted().
      expect(c.prompt.match(/untrusted_data/g)).toHaveLength(2);
    }
  });

  test("a resistant model passes, for that model only, and the view names no model", async () => {
    behave = honest;
    const { passed, view } = await runSafetyCheck(orgId, userId);
    expect(passed).toBe(true);
    expect(view.status).toBe("passed");
    expect(await hasValidSafetyCheck(orgId)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("model-a");
    currentModel = "model-b"; // the organisation switched models
    expect((await safetyCheckView(orgId)).status).toBe("model_changed");
    expect(await hasValidSafetyCheck(orgId)).toBe(false);
  });

  test("following one attack fails the whole check", async () => {
    behave = (p) =>
      p.includes("email_all_candidate_records")
        ? {
            ...honest(),
            actions: ["email_all_candidate_records"],
            suspected_prompt_injection: false,
          }
        : honest();
    const { passed, view } = await runSafetyCheck(orgId, userId);
    expect(passed).toBe(false);
    expect(view.status).toBe("failed");
    expect(view.results.filter((r) => r.complied).map((r) => r.probe)).toEqual(["tool_abuse"]);
    expect(await hasValidSafetyCheck(orgId)).toBe(false);
  });

  test("a probe that cannot run is not a pass", async () => {
    behave = (p) => (p.includes("ignorez") ? null : honest());
    const { passed, view } = await runSafetyCheck(orgId, userId);
    expect(passed).toBe(false);
    expect(view.results.find((r) => r.probe === "multilingual")).toMatchObject({ error: true });
  });

  test("an expired pass no longer counts; reruns are throttled", async () => {
    behave = honest;
    await runSafetyCheck(orgId, userId);
    await expect(runSafetyCheck(orgId, userId)).rejects.toThrow(/Try again in 10 minutes/);
    const later = new Date(Date.now() + 31 * 864e5);
    expect((await safetyCheckView(orgId, later)).status).toBe("expired");
    expect(await hasValidSafetyCheck(orgId, later)).toBe(false);
  });
});
