/**
 * Request rate limiting (src/server/rate-limit.ts, docs/guardrails.md P2-2):
 * the per-instance window, the sliding estimate, and the shared Postgres store
 * enforcing ONE limit across two separate processes (two "instances").
 * Run: DATABASE_URL=... SESSION_SECRET=... bun test scripts/rate-limit.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const { allowInMemory, allowRequest, slidingCount, RATE_LIMIT } =
  await import("../src/server/rate-limit");
const { sql } = await import("../src/server/db");

const stamp = Date.now();

afterAll(async () => {
  await sql`delete from rate_limit_hits where key like ${`rl-test-${stamp}%`}`;
});

describe("per-instance window", () => {
  test(`allows ${RATE_LIMIT} a minute, then refuses; a minute later allows again`, () => {
    const key = `mem-${stamp}`;
    const t0 = 1_000_000;
    for (let i = 0; i < RATE_LIMIT; i++) expect(allowInMemory(key, t0 + i)).toBe(true);
    expect(allowInMemory(key, t0 + RATE_LIMIT)).toBe(false);
    expect(allowInMemory(key, t0 + 60_001 + RATE_LIMIT)).toBe(true);
  });
});

describe("sliding estimate", () => {
  test("the previous window fades out across the current one", () => {
    expect(slidingCount(60, 0, 0)).toBe(60);
    expect(slidingCount(60, 10, 0.5)).toBe(40);
    expect(slidingCount(60, 10, 1)).toBe(10);
  });
});

describe("shared store (RATE_LIMIT_STORE=postgres)", () => {
  test("two processes share one limit for the same caller", async () => {
    process.env["RATE_LIMIT_STORE"] = "postgres";
    const key = `rl-test-${stamp}-shared`;
    // Pin `now` to the start of a window so the previous window weighs fully
    // and nothing from it exists: the limit is exactly RATE_LIMIT.
    const now = Math.ceil(Date.now() / 60_000) * 60_000 + 5;
    let allowedHere = 0;
    for (let i = 0; i < 40; i++) if (await allowRequest(key, now)) allowedHere++;
    // A second, separate process — another instance — hits the same caller.
    const child = Bun.spawnSync(
      [
        "bun",
        "-e",
        `const { allowRequest } = await import("${process.cwd()}/src/server/rate-limit.ts");
         let n = 0; for (let i = 0; i < 40; i++) if (await allowRequest(${JSON.stringify(key)}, ${now})) n++;
         console.log("ALLOWED=" + n); process.exit(0);`,
      ],
      { env: { ...process.env, RATE_LIMIT_STORE: "postgres" } },
    );
    const allowedThere = Number(/ALLOWED=(\d+)/.exec(child.stdout.toString())?.[1] ?? NaN);
    expect(allowedHere).toBe(40);
    expect(allowedThere).toBe(RATE_LIMIT - 40);
    const [row] = (await sql`select hits from rate_limit_hits where key = ${key}`) as unknown as {
      hits: number;
    }[];
    expect(row!.hits).toBe(80);
  });

  test("a different caller has its own budget", async () => {
    process.env["RATE_LIMIT_STORE"] = "postgres";
    expect(await allowRequest(`rl-test-${stamp}-other`)).toBe(true);
  });
});

/**
 * The auth dispatch in src/server.ts. The SSR entry is stubbed so a request
 * that passes the limiter is a 200 and a throttled one is the 429 response.
 * RATE_LIMIT_STORE stays on the default (in-memory), so no database here.
 */
const { AUTH_RATE_LIMIT } = await import("../src/server/rate-limit");
mock.module("@tanstack/react-start/server-entry", () => ({
  default: { fetch: async () => new Response("handled") },
}));
const server = (await import("../src/server")).default as {
  fetch: (request: Request) => Promise<Response>;
};

function call(path: string, ip: string, method = "GET"): Promise<Response> {
  return server.fetch(
    new Request(`http://localhost${path}`, { method, headers: { "x-forwarded-for": ip } }),
  );
}

describe("auth read endpoints (server dispatch)", () => {
  // The shared-store tests above leave the postgres store selected; these run
  // against the in-process window, so reset it before each one.
  beforeEach(() => {
    delete process.env["RATE_LIMIT_STORE"];
  });

  test(`GET /api/auth/session is 429 after the normal ${RATE_LIMIT}/min budget`, async () => {
    const ip = "10.1.0.1";
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await call("/api/auth/session", ip)).status).toBe(200);
    expect((await call("/api/auth/session", ip)).status).toBe(429);
  });

  test(`GET /api/auth/me is 429 after the normal ${RATE_LIMIT}/min budget`, async () => {
    const ip = "10.1.0.2";
    for (let i = 0; i < RATE_LIMIT; i++) expect((await call("/api/auth/me", ip)).status).toBe(200);
    expect((await call("/api/auth/me", ip)).status).toBe(429);
  });

  test(`GET /api/auth/confirm hits the tighter ${AUTH_RATE_LIMIT} budget sooner than session does`, async () => {
    const ip = "10.1.0.3";
    for (let i = 0; i < AUTH_RATE_LIMIT; i++)
      expect((await call("/api/auth/confirm", ip)).status).toBe(200);
    expect((await call("/api/auth/confirm", ip)).status).toBe(429);
    expect(AUTH_RATE_LIMIT).toBeLessThan(RATE_LIMIT);
  });

  test(`POST /api/auth/confirm still hits the ${AUTH_RATE_LIMIT} mutation budget`, async () => {
    const ip = "10.1.0.4";
    for (let i = 0; i < AUTH_RATE_LIMIT; i++)
      expect((await call("/api/auth/confirm", ip, "POST")).status).toBe(200);
    expect((await call("/api/auth/confirm", ip, "POST")).status).toBe(429);
  });

  test("OPTIONS stays exempt on session, me and confirm", async () => {
    const ip = "10.1.0.5";
    for (const path of ["/api/auth/session", "/api/auth/me", "/api/auth/confirm"]) {
      expect((await call(path, ip, "OPTIONS")).status).toBe(200);
    }
  });

  test("a spent session budget does not touch the mutation budgets of the same caller", async () => {
    const ip = "10.1.0.6";
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await call("/api/auth/session", ip)).status).toBe(200);
    expect((await call("/api/auth/session", ip)).status).toBe(429);
    expect((await call("/api/auth/login", ip, "POST")).status).toBe(200);
    expect((await call("/api/auth/confirm", ip)).status).toBe(200);
  });
});
