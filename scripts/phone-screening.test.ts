/**
 * Phone screening foundations (M1, docs/voice-screening-agent.md) against the
 * disposable database:
 *  - which candidate numbers may be dialled (Indian mobiles only) and how;
 *  - the organisation's policy: defaults, saving (audited), the database's
 *    own limits;
 *  - the AI voice credential: a service-account key validated, stored
 *    encrypted, reported as booleans only, preferred over the API key, and no
 *    voice at all for an organisation without one;
 *  - readiness: switched on + a phone line + a voice credential.
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/phone-screening.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

process.env["SECRET_ENCRYPTION_KEY"] ??= randomBytes(32).toString("base64");
// A phone line for this deployment (read once, when env.ts loads).
process.env["SIP_SERVER"] ??= "127.0.0.1";
process.env["SIP_USER"] ??= "3001";
process.env["SIP_PASSWORD"] ??= "test-only";

const { db } = await import("../src/server/db");
const { aiProviderCredentials, auditLog, organizations, phoneScreeningSettings, users } =
  await import("../drizzle/schema");
const { dialNumber } = await import("../src/server/voice/phone");
const settings = await import("../src/server/voice/settings.server");
const gw = await import("../src/lib/ai-gateway.server");

const stamp = Date.now();
let orgId: string;
let userId: string;
const actor = () => ({ userId, memberEmail: `ps-${stamp}@test.local` });

function serviceAccountJson(over: Record<string, unknown> = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    client_email: "voice@test-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
    ...over,
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  userId = (
    await db
      .insert(users)
      .values({ email: `ps-${stamp}@test.local` })
      .returning({ id: users.id })
  )[0]!.id;
  orgId = (
    await db
      .insert(organizations)
      .values({ name: "Phone Org", slug: `ps-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("numbers we may dial", () => {
  test.each([
    ["9876543210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["098765-43210", "9876543210"],
    ["919876543210", "9876543210"],
    ["(+91) 6123-456-789", "6123456789"],
    ["98400 12345 / 044 2345 6789", "9840012345"],
    ["044 2345 6789, 98400 12345", "9840012345"],
  ])("%s → %s", (raw, dial) => {
    expect(dialNumber(raw)).toEqual({ dial, last4: dial.slice(-4) });
  });

  test("anything else is not dialled", () => {
    for (const raw of ["+1 415 555 0100", "044 2345 6789", "12345", "", null, undefined, "n/a"])
      expect(dialNumber(raw)).toBeNull();
  });
});

describe("the organisation's phone screening policy", () => {
  test("defaults until saved; saving is audited and read back", async () => {
    expect(await settings.phoneScreeningPolicyOf(orgId)).toEqual(
      settings.DEFAULT_PHONE_SCREENING_POLICY,
    );
    const policy = {
      enabled: true,
      assistantName: "  Saranya ",
      windowStartMinute: 9 * 60 + 30,
      windowEndMinute: 18 * 60,
      callDays: [5, 1, 3, 1],
      maxAttempts: 2,
      maxMinutes: 12,
      maxReschedules: 1,
      voice: "Aoede",
      nextStepsText: "  we reply within two working days  ",
      schedulingEnabled: true,
      schedulingWaitHours: 36,
      negotiationEnabled: true,
    };
    await settings.setPhoneScreeningPolicyCore(orgId, actor(), policy);
    expect(await settings.phoneScreeningPolicyOf(orgId)).toEqual({
      ...policy,
      assistantName: "Saranya",
      callDays: [1, 3, 5],
      nextStepsText: "we reply within two working days",
    });
    const audit = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "screening_call.settings.set")));
    expect(audit).toHaveLength(1);
  });

  test("the database refuses impossible policies", async () => {
    const bad = [
      { windowStartMinute: 900, windowEndMinute: 600 },
      { maxAttempts: 9 },
      { maxMinutes: 120 },
      { maxReschedules: 9 },
      { schedulingWaitHours: 1 },
      { schedulingWaitHours: 200 },
      { assistantName: "S" },
    ];
    for (const b of bad) {
      let refused = false;
      try {
        await db
          .update(phoneScreeningSettings)
          .set(b)
          .where(eq(phoneScreeningSettings.orgId, orgId));
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }
  });
});

describe("the AI voice credential", () => {
  test("a service-account key is validated before it is stored", () => {
    expect(gw.parseVoiceServiceAccount("not json", "us-central1")).toMatchObject({ ok: false });
    expect(
      gw.parseVoiceServiceAccount(serviceAccountJson({ type: "authorized_user" }), "us-central1"),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/not a service-account/) });
    expect(
      gw.parseVoiceServiceAccount(serviceAccountJson({ private_key: "" }), "us-central1"),
    ).toMatchObject({ ok: false });
    expect(gw.parseVoiceServiceAccount(serviceAccountJson(), "Mumbai!")).toMatchObject({
      ok: false,
    });
    const ok = gw.parseVoiceServiceAccount(serviceAccountJson(), "asia-south1");
    expect(ok).toMatchObject({
      ok: true,
      vertex: { project: "test-project", location: "asia-south1" },
    });
  });

  test("stored encrypted, reported as booleans, read back, removed", async () => {
    expect(await gw.voiceCredentialStatus(orgId)).toEqual({ serviceAccount: false, apiKey: false });
    const parsed = gw.parseVoiceServiceAccount(serviceAccountJson(), "us-central1");
    if (!parsed.ok) throw new Error(parsed.message);
    await gw.writeVoiceServiceAccount(orgId, parsed.vertex);

    const [row] = await db
      .select({ apiKey: aiProviderCredentials.apiKey })
      .from(aiProviderCredentials)
      .where(
        and(
          eq(aiProviderCredentials.orgId, orgId),
          eq(aiProviderCredentials.provider, "google_vertex"),
        ),
      );
    expect(row!.apiKey).not.toContain("PRIVATE KEY");
    expect(row!.apiKey).not.toContain("test-project");

    expect(await gw.voiceCredentialStatus(orgId)).toEqual({ serviceAccount: true, apiKey: false });
    expect(await gw.readVoiceServiceAccount(orgId)).toEqual(parsed.vertex);

    await gw.clearVoiceServiceAccount(orgId);
    expect(await gw.readVoiceServiceAccount(orgId)).toBeNull();
  });

  test("no credential, no voice — never a platform key", async () => {
    const r = await gw.aiVoiceSession({ orgId, feature: "screening_call", system: "test" });
    expect(r).toMatchObject({ ok: false, status: 401 });
    if (!r.ok) expect(r.message).not.toMatch(/google|gemini|vertex/i);
  });
});

describe("readiness", () => {
  test("switched on + a phone line + a voice credential", async () => {
    await settings.setPhoneScreeningPolicyCore(orgId, actor(), {
      ...settings.DEFAULT_PHONE_SCREENING_POLICY,
      enabled: false,
    });
    expect(await settings.phoneScreeningReadiness(orgId)).toEqual({
      enabled: false,
      phoneLine: true,
      voice: false,
      ready: false,
    });
    await settings.setPhoneScreeningPolicyCore(orgId, actor(), {
      ...settings.DEFAULT_PHONE_SCREENING_POLICY,
      enabled: true,
    });
    expect((await settings.phoneScreeningReadiness(orgId)).ready).toBe(false);
    await gw.writeProviderKey(orgId, "google", "test-api-key-not-real");
    expect(await settings.phoneScreeningReadiness(orgId)).toEqual({
      enabled: true,
      phoneLine: true,
      voice: true,
      ready: true,
    });
  });
});

describe("the voice worker's heartbeat", () => {
  test("a beat in the last two minutes means a phone line is available", async () => {
    const { voiceWorkerHeartbeat } = await import("../drizzle/schema");
    const id = `test-${stamp}`;
    await settings.beat(id, 2, 0);
    expect(await settings.voiceWorkerAlive()).toBe(true);
    expect(await settings.voiceWorkerAlive(new Date(Date.now() + 5 * 60_000))).toBe(false);
    await db.delete(voiceWorkerHeartbeat).where(eq(voiceWorkerHeartbeat.workerId, id));
  });
});
