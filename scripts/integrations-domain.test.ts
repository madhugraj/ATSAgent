/**
 * Behaviour lockdown for the integrations domain (map §4 L2: LinkedIn connect,
 * meeting providers, OAuth connect state, calendar availability) so that ANY
 * behaviour change when these files move into an @ats/* package in Phase 4
 * fails a test. Locks down:
 *  - src/lib/oauth-state.ts: HMAC round-trip, provider binding, 30-minute
 *    window, missing orgId/userId, tamper, fail-closed on a short secret, and
 *    the assertAllowedOrigin open-redirect allowlist (the file moves to
 *    @ats/auth with zero coverage today);
 *  - src/lib/linkedin.server.ts: signState/verifyState (the LinkedIn-specific
 *    clone of the same logic) and linkedinOrgToken — org scoping, secrets at
 *    rest via encryptSecret/decryptSecret, near-expiry refresh re-encryption,
 *    no-row and expired-without-refresh refusals; fetchMember/postAsMember/
 *    probeCapabilities provider failure mapping (401 → LinkedinAuthError, 403
 *    publish refusal, 429 rate limit, live-probe status → ready true/false/null);
 *  - src/lib/meetings.server.ts: createMeeting dispatch (zoom/google/teams),
 *    the no-join-link refusal, the need() missing-credential copy, the Teams
 *    403 → calendar-event fallback and both-fail permission help;
 *  - src/lib/meetings.functions.ts: createMeetingLinkCore org scoping (a
 *    cross-org provider row must not be usable), disabled row refusal, happy
 *    path through readSecrets;
 *  - src/lib/calendar-availability.server.ts: busyFor Google and Microsoft
 *    provider branches, unreadable-calendar unknowns, provider-error
 *    degradation (never throws), no-connection fallback; findFreeSlots/isFree
 *    org isolation (another org's booked round with the same interviewer email
 *    must not block) and the calendar-busy refusal;
 *  - src/lib/meetings-oauth.server.ts: normaliseAccountEmail guest-UPN
 *    rebuild, and finishProviderConnect callback hardening (forged state,
 *    provider binding, error param, personal mailbox, pinned email domain,
 *    org-scoped secret write, cross-org row untouched).
 *
 * No mock.module: DB-backed on the disposable database like panel-access,
 * provider REST stubbed via globalThis.fetch (as agent-edge-cases does).
 * NOTE: the finishProviderConnect describe overwrites org A's Google Meet
 * credentials, so it must stay the LAST describe in this file.
 * Run: DATABASE_URL="$(…atsagent_test url)" bun --env-file=.env.local test scripts/integrations-domain.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

// CI runs the suites with only DATABASE_URL and SESSION_SECRET. These secrets
// only need to EXIST for the OAuth-state and credential tests: throwaway
// 32-byte values, real environment values always win. Fail-closed on a
// MISSING state secret is tested explicitly below. SECRET_ENCRYPTION_KEY must
// be set before any encryptSecret/decryptSecret call (crypto.ts caches it).
process.env.OAUTH_STATE_SECRET ??= `test-oauth-${"x".repeat(40)}`;
process.env.LINKEDIN_STATE_SECRET ??= `test-linkedin-${"x".repeat(40)}`;
process.env.SECRET_ENCRYPTION_KEY ??= Buffer.from("x".repeat(32)).toString("base64");
// The meetings OAuth provider map is built from the env snapshot at module
// load; the finishProviderConnect tests exercise the google pair with the
// token exchange stubbed via globalThis.fetch, so placeholder values suffice.
process.env.GOOGLE_OAUTH_CLIENT_ID ??= `test-google-client-${"x".repeat(20)}`;
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= `test-google-secret-${"x".repeat(20)}`;

const { db } = await import("../src/server/db");
const {
  applications,
  candidates,
  interviews,
  orgLinkedinConnections,
  organizations,
  requisitions,
} = await import("../drizzle/schema");
const { sourceIntegrations } = await import("../drizzle/schema");
const { encryptSecret, decryptSecret } = await import("../src/server/crypto");
const { env } = await import("../src/server/env");
const oauthState = await import("../src/lib/oauth-state");
const linkedin = await import("../src/lib/linkedin.server");
const meetingsServer = await import("../src/lib/meetings.server");
const meetingsFunctions = await import("../src/lib/meetings.functions");
const meetingsOauth = await import("../src/lib/meetings-oauth.server");
const availability = await import("../src/lib/calendar-availability.server");
const integrationsServer = await import("../src/lib/integrations.server");

const stamp = Date.now();
const domain = `inte${stamp}.test`;
const emailDomain = `corp${stamp}.example`;

let orgA: string;
let orgB: string;
let orgC: string;
let orgD: string; // Teams-only calendar org (org B also has Google Meet, which busyFor prefers)
let teamsD: string;
let zoomA: string; // org A zoom row (category meeting) — starts disabled
let gmeetA: string; // org A google_meet row
let gmeetB: string; // org B google_meet row
let teamsB: string; // org B teams row
const int1 = `int1@${domain}`;
const int2 = `int2@${domain}`;

function stubFetch(map: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: string[];
  restore: () => void;
} {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return await map(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

/** A minimal JWT-shaped id_token whose payload carries the given claims. */
const fakeIdToken = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.sig`;

async function seedApplication(org: string, code: string, email: string): Promise<string> {
  const [req] = await db
    .insert(requisitions)
    .values({ orgId: org, code, title: "Head of AI", status: "approved" } as never)
    .returning({ id: requisitions.id });
  const [c] = await db
    .insert(candidates)
    .values({ orgId: org, fullName: "Asha Candidate", email } as never)
    .returning({ id: candidates.id });
  const [a] = await db
    .insert(applications)
    .values({ orgId: org, requisitionId: req!.id, candidateId: c!.id, stage: "l1" } as never)
    .returning({ id: applications.id });
  return a!.id;
}

async function bookRound(org: string, appId: string, email: string, at: Date) {
  await db.insert(interviews).values({
    orgId: org,
    applicationId: appId,
    level: 1,
    interviewerEmail: email,
    scheduledAt: at,
    durationMins: 30,
    status: "scheduled",
  } as never);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const mkOrg = async (name: string) =>
    (
      await db
        .insert(organizations)
        .values({
          name,
          slug: name.toLowerCase().replace(/\s+/g, "-") + `-${stamp}`,
          status: "active",
        })
        .returning({ id: organizations.id })
    )[0]!.id;
  orgA = await mkOrg("Inte Org A");
  orgB = await mkOrg("Inte Org B");
  orgC = await mkOrg("Inte Org C");
  orgD = await mkOrg("Inte Org D");

  const mkRow = async (org: string, provider: string, label: string, enabled: boolean) =>
    (
      await db
        .insert(sourceIntegrations)
        .values({
          orgId: org,
          provider,
          label,
          category: "meeting",
          enabled,
          hasCredentials: true,
        } as never)
        .returning({ id: sourceIntegrations.id })
    )[0]!.id;
  zoomA = await mkRow(orgA, "zoom", "Zoom", false);
  gmeetA = await mkRow(orgA, "google_meet", "Google Meet", true);
  gmeetB = await mkRow(orgB, "google_meet", "Google Meet", true);
  teamsB = await mkRow(orgB, "teams", "Microsoft Teams", true);
  teamsD = await mkRow(orgD, "teams", "Microsoft Teams", true);
  await integrationsServer.writeSecrets(gmeetA, {
    refresh_token: "grt-A",
    client_id: "cid-A",
    client_secret: "csec-A",
  });
  await integrationsServer.writeSecrets(gmeetB, { refresh_token: "grt-B" });
  await integrationsServer.writeSecrets(teamsB, { refresh_token: "mrt-B" });
  await integrationsServer.writeSecrets(teamsD, { refresh_token: "mrt-D" });

  await db.insert(orgLinkedinConnections).values([
    {
      orgId: orgA,
      memberSub: `sub-A-${stamp}`,
      memberName: "Ada Org A",
      accessToken: encryptSecret(`access-A-${stamp}`),
      refreshToken: encryptSecret(`refresh-A-${stamp}`),
      expiresAt: new Date(Date.now() + 2 * 3600_000),
      scope: "openid profile email w_member_social",
    },
    {
      orgId: orgB,
      memberSub: `sub-B-${stamp}`,
      memberName: "Bob Org B",
      accessToken: encryptSecret(`access-B-${stamp}`),
      refreshToken: encryptSecret(`refresh-B-${stamp}`),
      expiresAt: new Date(Date.now() + 2 * 3600_000),
      scope: "openid profile email",
    },
  ] as never);
});

afterAll(async () => {
  await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB, orgC, orgD]));
});

describe("oauth-state (moves to @ats/auth with zero tests today)", () => {
  const payload = () => ({
    orgId: orgA,
    userId: `user-${stamp}`,
    provider: "google" as const,
    origin: "http://localhost:8080",
    ts: Date.now(),
    emailDomain,
  });

  test("round-trip preserves the payload", () => {
    const state = oauthState.signOAuthState(payload());
    expect(oauthState.verifyOAuthState(state, "google")).toMatchObject({
      orgId: orgA,
      userId: `user-${stamp}`,
      provider: "google",
      origin: "http://localhost:8080",
      emailDomain,
    });
  });

  test("a wrong expected provider, a tampered body and a tampered mac all verify to null", () => {
    const state = oauthState.signOAuthState(payload());
    expect(oauthState.verifyOAuthState(state, "zoom")).toBeNull();
    const [body, mac] = state.split(".");
    expect(oauthState.verifyOAuthState(`9${body!.slice(1)}.${mac}`)).toBeNull();
    expect(oauthState.verifyOAuthState(`${body}.${"0".repeat(mac!.length)}`)).toBeNull();
    expect(oauthState.verifyOAuthState("garbage")).toBeNull();
    expect(oauthState.verifyOAuthState(null)).toBeNull();
  });

  test("states older than 30 minutes, and states missing orgId or userId, are refused", () => {
    const old = oauthState.signOAuthState({ ...payload(), ts: Date.now() - 31 * 60_000 });
    expect(oauthState.verifyOAuthState(old)).toBeNull();
    expect(
      oauthState.verifyOAuthState(oauthState.signOAuthState({ ...payload(), orgId: "" } as never)),
    ).toBeNull();
    expect(
      oauthState.verifyOAuthState(oauthState.signOAuthState({ ...payload(), userId: "" } as never)),
    ).toBeNull();
  });

  test("a short/absent secret fails closed on sign and verify", () => {
    const state = oauthState.signOAuthState(payload()); // signed with the real secret
    const savedId = env.OAUTH_STATE_SECRET;
    const savedLinkedin = env.LINKEDIN_STATE_SECRET;
    env.OAUTH_STATE_SECRET = "too-short";
    try {
      expect(() => oauthState.signOAuthState(payload())).toThrow(/not configured/);
      // The existing signature must not become acceptable either — verify refuses everything.
      expect(oauthState.verifyOAuthState(state)).toBeNull();
    } finally {
      env.OAUTH_STATE_SECRET = savedId;
      env.LINKEDIN_STATE_SECRET = savedLinkedin;
    }
  });

  test("a MISSING secret fails closed on sign and verify (CI runs without these set)", () => {
    const savedId = env.OAUTH_STATE_SECRET;
    const savedLinkedin = env.LINKEDIN_STATE_SECRET;
    env.OAUTH_STATE_SECRET = undefined as unknown as string;
    env.LINKEDIN_STATE_SECRET = undefined as unknown as string;
    try {
      expect(() => oauthState.signOAuthState(payload())).toThrow(/not configured/);
      expect(oauthState.verifyOAuthState("any.body")).toBeNull();
      // The LinkedIn clone shares the same fail-closed shape.
      expect(() => linkedin.signState({ orgId: orgA, userId: "u", ts: Date.now() })).toThrow(
        /not configured/,
      );
      expect(linkedin.verifyState("any.body")).toBeNull();
    } finally {
      env.OAUTH_STATE_SECRET = savedId;
      env.LINKEDIN_STATE_SECRET = savedLinkedin;
    }
  });

  test("assertAllowedOrigin accepts the public site and the two localhost ports, strips a trailing slash, refuses anything else", () => {
    const site = env.PUBLIC_SITE_URL.replace(/\/$/, "");
    expect(oauthState.assertAllowedOrigin(`${site}/`)).toBe(site);
    expect(oauthState.assertAllowedOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(oauthState.assertAllowedOrigin("http://localhost:8081/")).toBe("http://localhost:8081");
    expect(() => oauthState.assertAllowedOrigin("https://evil.example")).toThrow(/origin/i);
  });
});

describe("linkedin.server signState/verifyState (the LinkedIn clone)", () => {
  const payload = () => ({
    orgId: orgA,
    userId: `user-${stamp}`,
    origin: "http://localhost:8080",
    ts: Date.now(),
  });

  test("round-trip preserves orgId, userId, origin and ts", () => {
    const signed = payload();
    const state = linkedin.signState(signed);
    expect(linkedin.verifyState(state)).toEqual(signed);
  });

  test("tampered body/mac, an old timestamp and a non-allowlisted origin all verify to null", () => {
    const state = linkedin.signState(payload());
    const [body, mac] = state.split(".");
    expect(linkedin.verifyState(`9${body!.slice(1)}.${mac}`)).toBeNull();
    expect(linkedin.verifyState(`${body}.${"0".repeat(mac!.length)}`)).toBeNull();
    expect(
      linkedin.verifyState(linkedin.signState({ ...payload(), ts: Date.now() - 31 * 60_000 })),
    ).toBeNull();
    expect(
      linkedin.verifyState(linkedin.signState({ ...payload(), origin: "https://evil.example" })),
    ).toBeNull();
  });

  test("a short secret fails closed on sign and verify", () => {
    const savedId = env.OAUTH_STATE_SECRET;
    const savedLinkedin = env.LINKEDIN_STATE_SECRET;
    env.OAUTH_STATE_SECRET = "too-short";
    env.LINKEDIN_STATE_SECRET = "too-short";
    try {
      expect(() => linkedin.signState(payload())).toThrow(/not configured/);
      expect(linkedin.verifyState("a.0".repeat(16))).toBeNull();
    } finally {
      env.OAUTH_STATE_SECRET = savedId;
      env.LINKEDIN_STATE_SECRET = savedLinkedin;
    }
  });
});

describe("linkedinOrgToken — the org-scoped credential read", () => {
  test("no row → refuses with the connect-first message", async () => {
    expect(linkedin.linkedinOrgToken(orgC)).rejects.toThrow(
      "This organisation has not connected LinkedIn yet.",
    );
  });

  test("org scoping + decryption at rest: each org gets its own decrypted token", async () => {
    const a = await linkedin.linkedinOrgToken(orgA);
    const b = await linkedin.linkedinOrgToken(orgB);
    expect(a).toEqual({ accessToken: `access-A-${stamp}`, memberSub: `sub-A-${stamp}` });
    expect(b).toEqual({ accessToken: `access-B-${stamp}`, memberSub: `sub-B-${stamp}` });
    // The stored value really is envelope-encrypted, not plaintext.
    const [row] = await db
      .select({ accessToken: orgLinkedinConnections.accessToken })
      .from(orgLinkedinConnections)
      .where(eq(orgLinkedinConnections.orgId, orgA));
    expect(row!.accessToken).toMatch(/^enc:v1\./);
    expect(row!.accessToken).not.toContain(`access-A-${stamp}`);
  });

  test("near expiry without a refresh token → LinkedinAuthError (re-connect required)", async () => {
    await db
      .update(orgLinkedinConnections)
      .set({ expiresAt: new Date(Date.now() + 60_000), refreshToken: null })
      .where(eq(orgLinkedinConnections.orgId, orgA));
    expect(linkedin.linkedinOrgToken(orgA)).rejects.toBeInstanceOf(linkedin.LinkedinAuthError);
  });

  test("near expiry with a refresh token refreshes and re-encrypts the row", async () => {
    await db
      .update(orgLinkedinConnections)
      .set({
        expiresAt: new Date(Date.now() + 60_000),
        refreshToken: encryptSecret(`refresh-A-${stamp}`),
      })
      .where(eq(orgLinkedinConnections.orgId, orgA));
    const stub = stubFetch((url) =>
      url.includes("oauth/v2/accessToken")
        ? json({
            access_token: `access-A2-${stamp}`,
            refresh_token: `refresh-A2-${stamp}`,
            expires_in: 7200,
          })
        : new Response("unexpected", { status: 500 }),
    );
    try {
      const token = await linkedin.linkedinOrgToken(orgA);
      expect(token.accessToken).toBe(`access-A2-${stamp}`);
      // Org B's row untouched by org A's refresh.
      const [b] = await db
        .select({ accessToken: orgLinkedinConnections.accessToken })
        .from(orgLinkedinConnections)
        .where(eq(orgLinkedinConnections.orgId, orgB));
      expect(decryptSecret(b!.accessToken)).toBe(`access-B-${stamp}`);
      const [a] = await db
        .select({
          accessToken: orgLinkedinConnections.accessToken,
          refreshToken: orgLinkedinConnections.refreshToken,
          expiresAt: orgLinkedinConnections.expiresAt,
        })
        .from(orgLinkedinConnections)
        .where(eq(orgLinkedinConnections.orgId, orgA));
      expect(decryptSecret(a!.accessToken)).toBe(`access-A2-${stamp}`);
      expect(decryptSecret(a!.refreshToken!)).toBe(`refresh-A2-${stamp}`);
      expect(a!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    } finally {
      stub.restore();
      // Restore the long-expiry row for later describes.
      await db
        .update(orgLinkedinConnections)
        .set({ expiresAt: new Date(Date.now() + 2 * 3600_000) })
        .where(eq(orgLinkedinConnections.orgId, orgA));
    }
  });
});

describe("LinkedIn provider failure mapping (fetch stubbed)", () => {
  test("fetchMember: 401 → LinkedinAuthError", async () => {
    const stub = stubFetch(() => new Response("expired", { status: 401 }));
    try {
      expect(linkedin.fetchMember("tok")).rejects.toBeInstanceOf(linkedin.LinkedinAuthError);
    } finally {
      stub.restore();
    }
  });

  test("postAsMember: 201 returns the post id; 401/403/429 map to re-auth, publish-refusal and rate-limit copy", async () => {
    const stub = stubFetch((_url, init) => {
      const auth = String(new Headers(init?.headers).get("Authorization"));
      switch (auth) {
        case "Bearer ok":
          return new Response(null, { status: 201, headers: { "x-restli-id": "share-1" } });
        case "Bearer expired":
          return new Response("expired", { status: 401 });
        case "Bearer forbidden":
          return new Response("no", { status: 403 });
        default:
          return new Response("slow down", { status: 429 });
      }
    });
    try {
      expect(await linkedin.postAsMember("ok", "sub-1", "hello")).toBe("share-1");
      expect(linkedin.postAsMember("expired", "sub-1", "hello")).rejects.toBeInstanceOf(
        linkedin.LinkedinAuthError,
      );
      expect(linkedin.postAsMember("forbidden", "sub-1", "hello")).rejects.toThrow(
        /LinkedIn declined publishing/,
      );
      expect(linkedin.postAsMember("rate", "sub-1", "hello")).rejects.toThrow(/rate limit/i);
    } finally {
      stub.restore();
    }
  });

  test("probeCapabilities maps the granted scope and live probe statuses into ready true/false/null", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("/v2/userinfo")) return json({ sub: "sub-1", name: "Ada" });
      if (url.includes("/rest/jobPostings")) throw new Error("network down"); // 0 → null
      return new Response("declined", { status: 403 }); // applications → false
    });
    try {
      const caps = await linkedin.probeCapabilities("tok", "openid profile w_member_social");
      expect(caps.map((c) => [c.id, c.ready])).toEqual([
        ["identity", true],
        ["publish", true],
        ["job_postings", null],
        ["applications", false],
      ]);
    } finally {
      stub.restore();
    }
  });

  test("probeCapabilities: publish not granted → false with a reconnect hint; dead identity short-circuits to one refused capability", async () => {
    const stub = stubFetch((url) =>
      url.includes("/v2/userinfo") ? json({ sub: "sub-1", name: "Ada" }) : json({}, 200),
    );
    try {
      const caps = await linkedin.probeCapabilities("tok", "openid profile");
      expect(caps.find((c) => c.id === "publish")!.ready).toBe(false);
      expect(caps.find((c) => c.id === "publish")!.detail).toMatch(/Reconnect|Reconnect LinkedIn/i);

      const stub401 = stubFetch(() => new Response("expired", { status: 401 }));
      try {
        const dead = await linkedin.probeCapabilities("tok", "w_member_social");
        expect(dead.length).toBe(1);
        expect(dead[0]!.ready).toBe(false);
        expect(dead[0]!.id).toBe("identity");
      } finally {
        stub401.restore();
      }
    } finally {
      stub.restore();
    }
  });
});

describe("meetings.server createMeeting dispatch (fetch stubbed)", () => {
  const req = {
    topic: "L1 interview",
    startIso: new Date(Date.now() + 86_400_000).toISOString(),
    durationMins: 30,
    attendees: ["cand@example.com"],
    agenda: null,
  };

  test("zoom: server-to-server token then meeting creation returns the join url", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("zoom.us/oauth/token")) return json({ access_token: "zt" });
      if (url.includes("api.zoom.us/v2/users/me/meetings"))
        return json({ join_url: "https://zoom.us/j/123", id: "123" });
      return new Response("unexpected", { status: 500 });
    });
    try {
      expect(
        await meetingsServer.createMeeting(
          "zoom",
          { account_id: "a", client_id: "c", client_secret: "s" },
          req,
        ),
      ).toEqual({ joinUrl: "https://zoom.us/j/123", externalId: "123", provider: "zoom" });
    } finally {
      stub.restore();
    }
  });

  test("a 200 without a join link is refused; missing secrets name the missing fields", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("zoom.us/oauth/token")) return json({ access_token: "zt" });
      return json({ join_url: "", id: "9" });
    });
    try {
      expect(
        meetingsServer.createMeeting(
          "zoom",
          { account_id: "a", client_id: "c", client_secret: "s" },
          req,
        ),
      ).rejects.toThrow("zoom did not return a join link.");
      expect(meetingsServer.createMeeting("zoom", {}, req)).rejects.toThrow(
        /Zoom is not fully configured.*Account ID.*Client secret value/s,
      );
    } finally {
      stub.restore();
    }
  });

  test("google_meet: refresh grant then calendar event returns the hangout link", async () => {
    const stub = stubFetch((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token"))
        return json({ access_token: "gt" });
      if (url.includes("calendars/primary/events"))
        return json({ id: "ev1", hangoutLink: "https://meet.google.com/xyz" });
      return new Response("unexpected", { status: 500 });
    });
    try {
      expect(
        await meetingsServer.createMeeting(
          "google_meet",
          { refresh_token: "grt", client_id: "c", client_secret: "s" },
          req,
        ),
      ).toEqual({
        joinUrl: "https://meet.google.com/xyz",
        externalId: "ev1",
        provider: "google_meet",
      });
    } finally {
      stub.restore();
    }
  });

  test("teams: a 403 on the dedicated online meeting falls back to the calendar event with a Teams link", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "mt" });
      if (url.endsWith("/onlineMeetings")) return new Response("no policy", { status: 403 });
      if (url.endsWith("/events"))
        return json({
          id: "ev2",
          onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" },
        });
      return new Response("unexpected", { status: 500 });
    });
    try {
      expect(
        await meetingsServer.createMeeting(
          "teams",
          {
            tenant_id: "t",
            client_id: "c",
            client_secret: "s",
            organizer_email: `hr@${emailDomain}`,
          },
          req,
        ),
      ).toEqual({
        joinUrl: "https://teams.microsoft.com/l/meetup-join/x",
        externalId: "ev2",
        provider: "teams",
      });
    } finally {
      stub.restore();
    }
  });

  test("teams: both the direct meeting and the calendar fallback failing surface the admin-permission help", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "mt" });
      return new Response("forbidden", { status: 403 });
    });
    try {
      expect(
        meetingsServer.createMeeting(
          "teams",
          {
            tenant_id: "t",
            client_id: "c",
            client_secret: "s",
            organizer_email: `hr@${emailDomain}`,
          },
          req,
        ),
      ).rejects.toThrow(/New-CsApplicationAccessPolicy/);
    } finally {
      stub.restore();
    }
  });
});

describe("meetings.functions createMeetingLinkCore — org scoping of the provider row", () => {
  const data = {
    provider: "zoom" as const,
    topic: "L1 interview",
    startIso: new Date(Date.now() + 86_400_000).toISOString(),
    durationMins: 30,
    attendees: [],
  };

  test("a provider row belonging to another org must not be usable", async () => {
    // org A has no teams row; org B does. The eq(orgId) + eq(provider) lookup
    // must refuse instead of picking org B's row.
    expect(
      meetingsFunctions.createMeetingLinkCore(orgA, { ...data, provider: "teams" }),
    ).rejects.toThrow("That meeting provider is not set up yet.");
  });

  test("a disabled row refuses with the label and the Integrations hint", async () => {
    expect(meetingsFunctions.createMeetingLinkCore(orgA, data)).rejects.toThrow(
      /Zoom is not connected — add the credentials on the Integrations page first\./,
    );
  });

  test("happy path: reads the org's stored secrets and returns the created meeting", async () => {
    await db
      .update(sourceIntegrations)
      .set({ enabled: true })
      .where(eq(sourceIntegrations.id, zoomA));
    await integrationsServer.writeSecrets(zoomA, {
      account_id: "acc",
      client_id: "cid",
      client_secret: "csec",
    });
    const stub = stubFetch((url) => {
      if (url.includes("zoom.us/oauth/token")) return json({ access_token: "zt" });
      if (url.includes("api.zoom.us/v2/users/me/meetings"))
        return json({ join_url: "https://zoom.us/j/456", id: "456" });
      return new Response("unexpected", { status: 500 });
    });
    try {
      expect(await meetingsFunctions.createMeetingLinkCore(orgA, data)).toEqual({
        joinUrl: "https://zoom.us/j/456",
        externalId: "456",
        provider: "zoom",
      });
    } finally {
      stub.restore();
      await db
        .update(sourceIntegrations)
        .set({ enabled: false })
        .where(eq(sourceIntegrations.id, zoomA));
    }
  });
});

describe("busyFor — provider branches, unknowns and degradation", () => {
  test("no connection → source null, everyone unknown, never throws", async () => {
    const busy = await availability.busyFor(
      orgC,
      [int1],
      new Date(),
      new Date(Date.now() + 3600_000),
    );
    expect(busy).toEqual({
      source: null,
      busy: {},
      unknown: [int1],
      note: "No Google or Microsoft calendar is connected, so availability could not be checked.",
    });
  });

  test("google: busy intervals parsed per email; unreadable calendars land in unknown with a note", async () => {
    const from = new Date(Date.now() + 86_400_000);
    const to = new Date(Date.now() + 90_000_000);
    const busyStart = new Date(Date.now() + 87_000_000);
    const busyEnd = new Date(Date.now() + 87_600_000);
    const stub = stubFetch((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token"))
        return json({ access_token: "gt" });
      if (url.includes("/freeBusy"))
        return json({
          calendars: {
            [int1]: { busy: [{ start: busyStart.toISOString(), end: busyEnd.toISOString() }] },
            [int2]: { errors: [{ domain: "notFound" }] },
          },
        });
      return new Response("unexpected", { status: 500 });
    });
    try {
      const busy = await availability.busyFor(orgA, [int1, int2], from, to);
      expect(busy.source).toBe("google");
      expect(busy.busy[int1]).toEqual([{ start: busyStart.getTime(), end: busyEnd.getTime() }]);
      expect(busy.unknown).toEqual([int2]);
      expect(busy.note).toContain(int2);
    } finally {
      stub.restore();
    }
  });

  test("microsoft: getSchedule items mapped, 'free' items filtered, error schedules unknown", async () => {
    const from = new Date(Date.now() + 86_400_000);
    const to = new Date(Date.now() + 90_000_000);
    const busyStart = new Date(Date.now() + 87_000_000);
    const busyEnd = new Date(Date.now() + 87_600_000);
    const stub = stubFetch((url) => {
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "mt" });
      if (url.includes("/calendar/getSchedule"))
        return json({
          value: [
            {
              scheduleId: int1,
              scheduleItems: [
                {
                  status: "busy",
                  start: { dateTime: busyStart.toISOString() },
                  end: { dateTime: busyEnd.toISOString() },
                },
                {
                  status: "free",
                  start: { dateTime: to.toISOString() },
                  end: { dateTime: to.toISOString() },
                },
              ],
            },
            { scheduleId: int2, error: { message: "no mailbox" } },
          ],
        });
      return new Response("unexpected", { status: 500 });
    });
    try {
      const busy = await availability.busyFor(orgD, [int1, int2], from, to);
      expect(busy.source).toBe("microsoft");
      expect(busy.busy[int1]).toEqual([{ start: busyStart.getTime(), end: busyEnd.getTime() }]);
      expect(busy.unknown).toEqual([int2]);
    } finally {
      stub.restore();
    }
  });

  test("provider error degrades to source null with a note — never throws", async () => {
    const stub = stubFetch((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token"))
        return json({ access_token: "gt" });
      return new Response("boom", { status: 500 });
    });
    try {
      const busy = await availability.busyFor(
        orgA,
        [int1],
        new Date(),
        new Date(Date.now() + 3600_000),
      );
      expect(busy.source).toBeNull();
      expect(busy.busy).toEqual({});
      expect(busy.unknown).toEqual([int1]);
      expect(busy.note).toContain("Google free/busy failed [500]");
    } finally {
      stub.restore();
    }
  });
});

describe("findFreeSlots / isFree — org isolation of booked rounds and the calendar-busy refusal", () => {
  const emptyCalendars = () =>
    stubFetch((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token"))
        return json({ access_token: "gt" });
      if (url.includes("/freeBusy"))
        return json({ calendars: { [int1]: { busy: [] }, [int2]: { busy: [] } } });
      return new Response("unexpected", { status: 500 });
    });

  test("a booked round in another org with the same interviewer email must not block org A's slots", async () => {
    const stub = emptyCalendars();
    try {
      const before = await availability.findFreeSlots(orgA, {
        interviewerEmail: int1,
        durationMins: 30,
        count: 3,
        timeZone: "UTC",
        earliest: true,
      });
      expect(before.checkedWith).toBe("google");
      expect(before.slots.length).toBeGreaterThan(0);
      const slot = before.slots[0]!;

      // Same email, same time — but a DIFFERENT organisation's round.
      const appIdB = await seedApplication(orgB, `REQ-IB-${stamp}`, `cand-b@${domain}`);
      await bookRound(orgB, appIdB, int1, new Date(slot));

      const after = await availability.findFreeSlots(orgA, {
        interviewerEmail: int1,
        durationMins: 30,
        count: 3,
        timeZone: "UTC",
        earliest: true,
      });
      expect(after.slots).toContain(slot);
      expect(await availability.isFree(orgA, int1, slot, 30)).toEqual({ free: true, reason: null });
      expect(await availability.isFree(orgB, int1, slot, 30)).toEqual({
        free: false,
        reason: "another interview is booked then",
      });

      // The same booking in org A itself does block.
      const appIdA = await seedApplication(orgA, `REQ-IA-${stamp}`, `cand-a@${domain}`);
      await bookRound(orgA, appIdA, int1, new Date(slot));
      expect(await availability.isFree(orgA, int1, slot, 30)).toEqual({
        free: false,
        reason: "another interview is booked then",
      });
      expect(
        (
          await availability.findFreeSlots(orgA, {
            interviewerEmail: int1,
            durationMins: 30,
            count: 3,
            timeZone: "UTC",
            earliest: true,
          })
        ).slots,
      ).not.toContain(slot);
    } finally {
      stub.restore();
    }
  });

  test("a connected calendar makes the slot busy when the interviewer is busy then", async () => {
    const stub = emptyCalendars();
    let baseline: string[];
    try {
      baseline = (
        await availability.findFreeSlots(orgA, {
          interviewerEmail: int2,
          durationMins: 30,
          count: 3,
          timeZone: "UTC",
          earliest: true,
        })
      ).slots;
      expect(baseline.length).toBeGreaterThan(1);
    } finally {
      stub.restore();
    }
    const target = baseline[1]!;
    const busyStub = stubFetch((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token"))
        return json({ access_token: "gt" });
      if (url.includes("/freeBusy"))
        return json({
          calendars: {
            [int2]: {
              busy: [
                {
                  start: new Date(target).toISOString(),
                  end: new Date(Date.parse(target) + 1_800_000).toISOString(),
                },
              ],
            },
          },
        });
      return new Response("unexpected", { status: 500 });
    });
    try {
      expect(await availability.isFree(orgA, int2, target, 30)).toEqual({
        free: false,
        reason: "the interviewer's calendar is busy then",
      });
    } finally {
      busyStub.restore();
    }
  });
});

describe("meetings-oauth: normaliseAccountEmail / emailDomainOf", () => {
  test("guest UPNs rebuild to the real personal address; plain addresses pass through", () => {
    expect(meetingsOauth.normaliseAccountEmail(`user_gmail.com#EXT#@tenant.onmicrosoft.com`)).toBe(
      "user@gmail.com",
    );
    expect(meetingsOauth.normaliseAccountEmail(`interviews@${emailDomain}`)).toBe(
      `interviews@${emailDomain}`,
    );
    expect(meetingsOauth.normaliseAccountEmail(`  Interviews@Corp.Example  `)).toBe(
      "interviews@corp.example",
    );
    expect(meetingsOauth.emailDomainOf(`Interviews@Corp.Example`)).toBe("corp.example");
    expect(meetingsOauth.emailDomainOf("no-at-sign")).toBeNull();
  });
});

describe("finishProviderConnect — the public callback tail (runs LAST: rewrites org A's Meet credentials)", () => {
  const stateFor = (org: string, provider: "google" | "zoom" = "google") =>
    oauthState.signOAuthState({
      orgId: org,
      userId: `user-${stamp}`,
      provider,
      origin: "http://localhost:8080",
      ts: Date.now(),
      emailDomain,
    });

  const callback = (query: string) =>
    new Request(`http://localhost:8080/api/public/integrations/google/callback?${query}`);

  const location = (res: Response) => new URL(res.headers.get("Location")!).searchParams;

  test("a forged or wrong-provider state is refused with 400", async () => {
    expect(
      await meetingsOauth.finishProviderConnect(callback("code=c&state=garbage"), "google"),
    ).toMatchObject({
      status: 400,
    });
    const res = await meetingsOauth.finishProviderConnect(
      callback(`code=c&state=${encodeURIComponent(stateFor(orgA, "zoom"))}`),
      "google",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid or expired connect request.");
  });

  test("a provider-reported error redirects back to Integrations with meetings=error", async () => {
    const res = await meetingsOauth.finishProviderConnect(
      callback(
        `error=access_denied&error_description=user+declined&state=${encodeURIComponent(stateFor(orgA))}`,
      ),
      "google",
    );
    expect(res.status).toBe(302);
    const back = location(res);
    expect(back.get("meetings")).toBe("error");
    expect(back.get("provider")).toBe("google");
    expect(back.get("detail")).toBe("user declined");
    expect(back.get("state")).toBeNull(); // never echoed back
  });

  test("a personal mailbox is refused regardless of who connected", async () => {
    const stub = stubFetch((url) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3600,
            id_token: fakeIdToken({ email: "person@gmail.com" }),
          })
        : new Response("unexpected", { status: 500 }),
    );
    try {
      const res = await meetingsOauth.finishProviderConnect(
        callback(`code=c&state=${encodeURIComponent(stateFor(orgA))}`),
        "google",
      );
      expect(res.status).toBe(302);
      expect(location(res).get("detail")).toMatch(/personal mailbox/i);
    } finally {
      stub.restore();
    }
  });

  test("an account whose domain differs from the emailDomain pinned in the signed state is refused", async () => {
    // NOTE: the refusal only activates when the pin carries an "@" (the
    // callback runs the pinned value through domainOf). Production callers
    // (integrations-oauth.functions.ts) currently pin a bare domain, which
    // domainOf() maps to null — so the check is skipped there. This test pins
    // the mechanism in email shape; see the handoff notes for the dead-pin gap.
    const pinned = oauthState.signOAuthState({
      orgId: orgA,
      userId: `user-${stamp}`,
      provider: "google",
      origin: "http://localhost:8080",
      ts: Date.now(),
      emailDomain: `owner@${emailDomain}`,
    });
    const stub = stubFetch((url) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3600,
            id_token: fakeIdToken({ email: "someone@other.example" }),
          })
        : new Response("unexpected", { status: 500 }),
    );
    try {
      const res = await meetingsOauth.finishProviderConnect(
        callback(`code=c&state=${encodeURIComponent(pinned)}`),
        "google",
      );
      expect(res.status).toBe(302);
      expect(location(res).get("meetings")).toBe("error");
      expect(location(res).get("detail")).toContain(`@${emailDomain}`);
    } finally {
      stub.restore();
    }
  });

  test("an org without the provider row is refused without touching other orgs", async () => {
    const stub = stubFetch((url) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3600,
            id_token: fakeIdToken({ email: `interviews@${emailDomain}` }),
          })
        : new Response("unexpected", { status: 500 }),
    );
    try {
      const res = await meetingsOauth.finishProviderConnect(
        callback(`code=c&state=${encodeURIComponent(stateFor(orgC))}`),
        "google",
      );
      expect(location(res).get("detail")).toBe(
        "Meeting provider row not found for this organisation.",
      );
      // Org B's credentials untouched by org C's attempt.
      expect((await integrationsServer.readSecrets(gmeetB))["refresh_token"]).toBe("grt-B");
    } finally {
      stub.restore();
    }
  });

  test("happy path: secrets land only on the org-scoped row, and the row is marked connected", async () => {
    const stub = stubFetch((url) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json({
            access_token: "at-happy",
            refresh_token: "rt-happy",
            expires_in: 3600,
            scope: "openid email calendar",
            id_token: fakeIdToken({ email: `interviews@${emailDomain}` }),
          })
        : new Response("unexpected", { status: 500 }),
    );
    try {
      const res = await meetingsOauth.finishProviderConnect(
        callback(`code=c&state=${encodeURIComponent(stateFor(orgA))}`),
        "google",
      );
      expect(res.status).toBe(302);
      expect(location(res).get("meetings")).toBe("connected");

      const secrets = await integrationsServer.readSecrets(gmeetA);
      expect(secrets["access_token"]).toBe("at-happy");
      expect(secrets["refresh_token"]).toBe("rt-happy");
      expect(secrets["connected_email"]).toBe(`interviews@${emailDomain}`);
      const [row] = await db
        .select({
          hasCredentials: sourceIntegrations.hasCredentials,
          enabled: sourceIntegrations.enabled,
          config: sourceIntegrations.config,
        })
        .from(sourceIntegrations)
        .where(eq(sourceIntegrations.id, gmeetA));
      expect(row!.hasCredentials).toBe(true);
      expect(row!.enabled).toBe(true);
      expect((row!.config as Record<string, string>)["connected_email"]).toBe(
        `interviews@${emailDomain}`,
      );
      // Org B's row keeps its own credentials.
      expect((await integrationsServer.readSecrets(gmeetB))["refresh_token"]).toBe("grt-B");
    } finally {
      stub.restore();
    }
  });
});
