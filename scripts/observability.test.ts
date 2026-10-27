/**
 * App-wide observability (README → Observability): request correlation
 * (traceparent → every log line → agent run), low-cardinality request metrics
 * and the /metrics endpoint, SLO maths, persisted SLI minutes, the Service
 * health data and burn-rate alerts — against the disposable local database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gte, inArray } from "drizzle-orm";

const { db } = await import("../src/server/db");
const { agentRuns, auditLog, organizations, serviceRequestMinutes, sloAlerts, users } =
  await import("../drizzle/schema");
const rc = await import("../src/server/request-context");
const hm = await import("../src/server/http-metrics");
const slo = await import("../src/server/slo");
const sloServer = await import("../src/server/slo.server");
const { log } = await import("../src/server/log");

/** Capture stdout/stderr JSON lines written while `fn` runs. */
async function captureLogs(
  fn: () => Promise<unknown> | unknown,
): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return lines
    .flatMap((l) => l.split("\n"))
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/* ------------------------------------------------------------ correlation */

describe("request correlation", () => {
  const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  test("parses valid traceparent and rejects malformed or zero ids", () => {
    expect(rc.parseTraceparent(parent)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      sampled: true,
    });
    expect(rc.parseTraceparent("garbage")).toBeNull();
    expect(rc.parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(
      rc.parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`),
    ).toBeNull();
    expect(
      rc.parseTraceparent(`ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`),
    ).toBeNull();
    expect(rc.parseTraceparent(null)).toBeNull();
  });

  test("continues the caller's trace, or starts a new one", () => {
    const cont = rc.contextFromHeaders(new Headers({ traceparent: parent }));
    expect(cont.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(cont.parentSpanId).toBe("00f067aa0ba902b7");
    expect(cont.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(cont.spanId).not.toBe("00f067aa0ba902b7");
    const fresh = rc.contextFromHeaders(new Headers());
    expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(rc.formatTraceparent(fresh)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  });

  test("trace id ↔ uuid round trip", () => {
    const u = rc.traceIdToUuid("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(u).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
    expect(rc.runTraceContext(u).traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test("every log line inside a request carries its trace; explicit fields win", async () => {
    const ctx = rc.contextFromHeaders(new Headers({ traceparent: parent }));
    const lines = await captureLogs(() =>
      rc.withRequestContext(ctx, async () => {
        log.info("one");
        await new Promise((r) => setTimeout(r, 1));
        log.child({ org_id: "o" }).warn("two");
        log.info("run", { trace_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
      }),
    );
    expect(lines.map((l) => l["msg"])).toEqual(["one", "two", "run"]);
    expect(lines[0]!["trace_id"]).toBe(ctx.traceId);
    expect(lines[0]!["span_id"]).toBe(ctx.spanId);
    expect(lines[1]!["trace_id"]).toBe(ctx.traceId);
    // Run traces are stored as uuids; logs use the 32-hex W3C form.
    expect(lines[2]!["trace_id"]).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
    const outside = await captureLogs(() => log.info("bare"));
    expect(outside[0]!["trace_id"]).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- metrics */

describe("request metrics", () => {
  test("route groups and templates never carry ids or tokens", () => {
    expect(hm.routeGroup("/_serverFn/abc123")).toBe("server_fn");
    expect(hm.routeGroup("/api/public/apply")).toBe("api_public");
    expect(hm.routeGroup("/api/auth/login")).toBe("api_auth");
    expect(hm.routeGroup("/assets/index-abc.js")).toBe("static");
    expect(hm.routeGroup("/metrics")).toBe("metrics");
    expect(hm.routeGroup("/candidates/5f0c7a52-1f0e-4d3b-9a7e-1b2c3d4e5f60")).toBe("page");

    expect(hm.routeTemplate("/candidates/5f0c7a52-1f0e-4d3b-9a7e-1b2c3d4e5f60")).toBe(
      "/candidates/:id",
    );
    expect(hm.routeTemplate("/offer/Zx9_kQ81mPnB7tLqRw3sY")).toBe("/offer/:id");
    expect(hm.routeTemplate("/requisitions/42")).toBe("/requisitions/:id");
    expect(hm.routeTemplate("/agents/observability")).toBe("/agents/observability");
    expect(hm.routeTemplate("/api/public/boards/acme/feed.xml")).toBe("/api/public/boards/:id/:id");
    expect(hm.routeTemplate("/_serverFn/eyJmaWxlIjoi/extra")).toBe("/_serverFn/:fn");
    expect(hm.serverFnId("/_serverFn/abc_DEF-1/junk")).toBe("abc_DEF-1");
    expect(hm.statusClass(503)).toBe("5xx");
    expect(hm.methodLabel("PROPFIND")).toBe("OTHER");
  });

  test("OpenMetrics output uses only the fixed label set", () => {
    hm.resetHttpMetrics();
    for (const [path, status, ms] of [
      ["/_serverFn/x1", 200, 30],
      ["/_serverFn/x2", 500, 3_000],
      ["/candidates/5f0c7a52-1f0e-4d3b-9a7e-1b2c3d4e5f60", 200, 120],
      ["/api/public/apply/secret-token-value", 429, 1],
    ] as const) {
      hm.requestStarted();
      hm.recordRequest({ group: hm.routeGroup(path), method: "POST", status, durationMs: ms });
    }
    const text = hm.renderOpenMetrics();
    expect(text).toContain(
      'atsiq_http_requests_total{route_group="server_fn",method="POST",status_class="5xx"} 1',
    );
    expect(text).toContain(
      'atsiq_http_request_duration_seconds_bucket{route_group="server_fn",le="0.05"} 1',
    );
    expect(text).toContain(
      'atsiq_http_request_duration_seconds_bucket{route_group="server_fn",le="+Inf"} 2',
    );
    expect(text).toContain("atsiq_http_requests_in_flight 0");
    expect(text.trimEnd().endsWith("# EOF")).toBe(true);
    // No path, id or token ever reaches a label.
    expect(text).not.toContain("5f0c7a52");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("x1");
    const labels = new Set([...text.matchAll(/([a-z_]+)="/g)].map((m) => m[1]));
    expect([...labels].sort()).toEqual(["le", "method", "route_group", "status_class"]);
  });

  test("SLI minutes: closed minutes drain, errors and slow requests counted", () => {
    hm.resetHttpMetrics();
    const t0 = Date.UTC(2099, 0, 1, 10, 0, 0);
    const rec = (status: number, ms: number, at: number) => {
      hm.requestStarted();
      hm.recordRequest({ group: "server_fn", method: "POST", status, durationMs: ms, at });
    };
    rec(200, 10, t0);
    rec(500, 10, t0 + 5_000);
    rec(200, slo.LATENCY_THRESHOLD_MS + 1, t0 + 10_000);
    rec(200, 10, t0 + 60_000); // next minute, still open
    hm.requestStarted();
    hm.recordRequest({ group: "static", method: "GET", status: 200, durationMs: 1, at: t0 });

    const drained = hm.drainClosedSliMinutes(t0 + 61_000);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ routeGroup: "server_fn", requests: 3, errors: 1, slow: 1 });
    expect(drained[0]!.latency.reduce((a, b) => a + b, 0)).toBe(3);
    expect(hm.drainClosedSliMinutes(t0 + 121_000)).toHaveLength(1);
    hm.resetHttpMetrics();
  });
});

/* --------------------------------------------------------------- SLO maths */

describe("SLO maths", () => {
  test("burn rate, budget and the multi-window rule", () => {
    expect(slo.burnRate({ total: 1000, bad: 10 }, 0.99)).toBeCloseTo(1);
    expect(slo.burnRate({ total: 0, bad: 0 }, 0.99)).toBeNull();
    expect(slo.budgetRemaining({ total: 1000, bad: 5 }, 0.99)).toBeCloseTo(0.5);
    expect(slo.budgetRemaining({ total: 1000, bad: 20 }, 0.99)).toBeCloseTo(-1);
    expect(slo.sliRatio({ total: 4, bad: 1 })).toBe(0.75);

    const all =
      (bad: number, total = 1000) =>
      () => ({ total, bad });
    expect(slo.firingBurnAlert(0.99, all(200))?.severity).toBe("critical");
    expect(slo.firingBurnAlert(0.99, all(70))?.severity).toBe("serious");
    expect(slo.firingBurnAlert(0.99, all(5))).toBeNull();
    // Too few events never fire.
    expect(slo.firingBurnAlert(0.99, all(10, 10))).toBeNull();
    // Long window burning but the short one recovered: no page.
    expect(
      slo.firingBurnAlert(0.99, (m) =>
        m <= 30 ? { total: 1000, bad: 0 } : { total: 1000, bad: 200 },
      ),
    ).toBeNull();
  });

  test("SLOs are defined once with sane targets", () => {
    expect(slo.SLOS.map((s) => s.id).sort()).toEqual([
      "agent_run_success",
      "server_fn_availability",
      "server_fn_latency",
    ]);
    for (const s of slo.SLOS) {
      expect(s.target).toBeGreaterThan(0.5);
      expect(s.target).toBeLessThan(1);
    }
  });

  test("percentile from latency buckets", () => {
    const b = [...hm.DURATION_BUCKETS.map(() => 0), 0];
    b[0] = 90;
    b[5] = 10; // 2.5 s bucket
    expect(sloServer.percentileFromBuckets(b, 0.5)).toBe(0.05);
    expect(sloServer.percentileFromBuckets(b, 0.95)).toBe(2.5);
    expect(
      sloServer.percentileFromBuckets(
        b.map(() => 0),
        0.95,
      ),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------- database */

const FUTURE = Date.UTC(2099, 5, 1, 12, 0, 0);
const INSTANCE = `obs-test-${Date.now()}`;
let orgId: string;
let userId: string;

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  const stamp = Date.now();
  const [u] = await db
    .insert(users)
    .values({ email: `obs-${stamp}@test.local` })
    .returning({ id: users.id });
  userId = u!.id;
  const [o] = await db
    .insert(organizations)
    .values({ name: "Obs Org", slug: `obs-org-${stamp}`, status: "active" })
    .returning({ id: organizations.id });
  orgId = o!.id;
});

afterAll(async () => {
  await db
    .delete(serviceRequestMinutes)
    .where(gte(serviceRequestMinutes.minute, new Date(Date.UTC(2099, 0, 1))));
  await db.delete(serviceRequestMinutes).where(eq(serviceRequestMinutes.instanceId, INSTANCE));
  await db.delete(sloAlerts).where(gte(sloAlerts.openedAt, new Date(Date.UTC(2099, 0, 1))));
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
});

function minute(offsetMin: number, requests: number, errors: number, slow = 0): hm.SliMinute {
  const latency = [...hm.DURATION_BUCKETS.map(() => 0), 0];
  latency[1] = requests - slow;
  latency[6] = slow;
  return {
    minute: FUTURE - offsetMin * 60_000,
    routeGroup: "server_fn",
    requests,
    errors,
    slow,
    latency,
  };
}

describe("persisted SLIs and burn alerts", () => {
  test("minutes from two flushes of one instance add up", async () => {
    await sloServer.writeMinutes([minute(3, 10, 1, 2)], INSTANCE);
    await sloServer.writeMinutes([minute(3, 5, 0, 1)], INSTANCE);
    const [row] = await db
      .select()
      .from(serviceRequestMinutes)
      .where(
        and(
          eq(serviceRequestMinutes.instanceId, INSTANCE),
          eq(serviceRequestMinutes.minute, new Date(FUTURE - 3 * 60_000)),
        ),
      );
    expect(row).toMatchObject({ requests: 15, errors: 1, slow: 3 });
    expect(row!.latency[1]).toBe(12);
    expect(row!.latency[6]).toBe(3);
    const c = await sloServer.sloCounts("server_fn_availability", 10, FUTURE);
    expect(c).toEqual({ total: 15, bad: 1 });
    expect(await sloServer.sloCounts("server_fn_latency", 10, FUTURE)).toEqual({
      total: 15,
      bad: 3,
    });
  });

  test("a fast burn opens one critical alert, notifies once, then resolves", async () => {
    // 1 h of heavy 5xx on server functions (well above 14.4× a 1 % budget).
    const rows = Array.from({ length: 60 }, (_, i) => minute(i + 1, 100, 40));
    await sloServer.writeMinutes(rows, `${INSTANCE}-b`);

    const first = await sloServer.evaluateSloBurn(FUTURE);
    expect(first.opened).toBeGreaterThanOrEqual(1);
    const [open] = await db
      .select()
      .from(sloAlerts)
      .where(and(eq(sloAlerts.slo, "server_fn_availability"), eq(sloAlerts.status, "open")));
    expect(open?.severity).toBe("critical");
    expect(open?.notifiedAt).not.toBeNull();
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "slo.alert.notified"), eq(auditLog.entityId, open!.id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.detail)).not.toContain(INSTANCE);

    // Re-evaluating while still burning does not re-notify.
    const again = await sloServer.evaluateSloBurn(FUTURE + 60_000);
    expect(again.opened).toBe(0);
    expect(again.notified).toBe(0);

    // The panel shows it.
    const health = await sloServer.serviceHealthData(FUTURE);
    const avail = health.slos.find((s) => s.id === "server_fn_availability")!;
    expect(avail.alert?.severity).toBe("critical");
    expect(avail.budgetRemaining).toBeLessThan(0);
    expect(
      health.routeGroups.find((g) => g.routeGroup === "server_fn")?.requests24h,
    ).toBeGreaterThan(0);
    // No vendor/model, org or instance data in the payload.
    expect(JSON.stringify(health)).not.toContain(INSTANCE);

    // Hours later with clean traffic, it resolves.
    const later = FUTURE + 8 * 3_600_000;
    await sloServer.writeMinutes(
      Array.from({ length: 60 }, (_, i) => ({
        ...minute(0, 100, 0),
        minute: later - (i + 1) * 60_000,
      })),
      `${INSTANCE}-c`,
    );
    const done = await sloServer.evaluateSloBurn(later);
    expect(done.resolved).toBeGreaterThanOrEqual(1);
    const stillOpen = await db
      .select()
      .from(sloAlerts)
      .where(and(eq(sloAlerts.slo, "server_fn_availability"), eq(sloAlerts.status, "open")));
    expect(stillOpen).toHaveLength(0);
  });

  test("an agent run started inside a request joins the request's trace", async () => {
    await import("../src/server/agents/index");
    const { startRun } = await import("../src/server/agents/runtime.server");
    const ctx = rc.contextFromHeaders(new Headers());
    const { runId } = await rc.withRequestContext(ctx, () =>
      startRun({ orgId, agentType: "sourcing", principalUserId: userId, goal: "obs test" }),
    );
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run!.traceId.replace(/-/g, "")).toBe(ctx.traceId);
    await db.delete(agentRuns).where(inArray(agentRuns.id, [runId]));
  });
});

/* ---------------------------------------------------------- HTTP entry */

describe("server entry", () => {
  test("/metrics is off without a token, 401 with a wrong one, OpenMetrics with the right one", async () => {
    const server = (await import("../src/server")).default;
    const call = (headers: Record<string, string> = {}) =>
      server.fetch(new Request("http://localhost/metrics", { headers }), {}, {});

    delete process.env["METRICS_TOKEN"];
    expect((await call()).status).toBe(404);

    process.env["METRICS_TOKEN"] = "test-metrics-token-0123456789";
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);

    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let res!: Response;
    const lines = await captureLogs(async () => {
      res = await call({
        authorization: "Bearer test-metrics-token-0123456789",
        traceparent: parent,
      });
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/openmetrics-text");
    expect(res.headers.get("x-request-id")).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(res.headers.get("traceparent")).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    );
    expect(await res.text()).toContain("atsiq_http_requests_total");

    const req = lines.find((l) => l["msg"] === "http.request");
    expect(req).toMatchObject({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      http_route: "/metrics",
      route_group: "metrics",
      http_status: 200,
      status_class: "2xx",
    });
    expect(typeof req!["duration_ms"]).toBe("number");
    delete process.env["METRICS_TOKEN"];
  });
});
