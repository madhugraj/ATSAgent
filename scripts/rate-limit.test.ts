/**
 * Request rate limiting (src/server/rate-limit.ts, docs/guardrails.md P2-2):
 * the per-instance window, the sliding estimate, and the shared Postgres store
 * enforcing ONE limit across two separate processes (two "instances").
 * Run: DATABASE_URL=... SESSION_SECRET=... bun test scripts/rate-limit.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";

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
