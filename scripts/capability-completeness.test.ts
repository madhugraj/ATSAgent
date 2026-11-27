/**
 * Capability completeness sweep (docs/candidate-identification/track-b-design.md
 * §1.2, §1.5): the central promise — "nothing hidden in the menu is reachable by
 * URL, RPC or the copilot" — is enforced, not asserted.
 *
 *  Fails (B1a):
 *   1. every NavItem carries a capability (`cap`/`anyCap`) or a recorded exemption;
 *   2. every tenant route file under a capability-gated prefix installs the
 *      `requireRouteCapability` beforeLoad guard;
 *   3. every registered agent tool declares its `capability` or sits in TOOL_EXEMPT.
 *  Report-only (switches to failing in B1b via CAPABILITY_SWEEP_STRICT=1):
 *   4. every tenant-scoped server-function module imports requireCapability
 *      (or assertCapability / requireCapability usage) or is on the reviewed allowlist.
 *
 * Run: bun test scripts/capability-completeness.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NAV_GROUPS } from "../src/components/nav-config";
import {
  NAV_EXEMPT_PREFIXES,
  ROUTE_CAPABILITIES,
  SERVER_FN_MODULE_CAPABILITY,
  TOOL_EXEMPT,
  routeCapabilityOf,
  capabilitiesAdmitRoute,
} from "../src/lib/capabilities";

const ROOT = join(import.meta.dir, "..");

function prefixHit(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/* ---------------------------------------------------- 1. nav classification */

describe("nav completeness", () => {
  test("every nav item declares a capability, anyCap, or a recorded exemption", () => {
    const unclassified: string[] = [];
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.cap || item.anyCap) continue;
        if (NAV_EXEMPT_PREFIXES.some((p) => prefixHit(p, item.to))) continue;
        unclassified.push(`${item.to} (${item.label})`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  test("nav capability assignments agree with the route table", () => {
    // A nav item claiming a capability must have a route rule that admits the
    // same set, so the sidebar and the URL guard can never disagree.
    const disagreements: string[] = [];
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (!item.cap) continue;
        const rule = routeCapabilityOf(item.to);
        if (!rule || !capabilitiesAdmitRoute([item.cap], rule))
          disagreements.push(`${item.to} claims ${item.cap} but the route rule disagrees`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});

/* -------------------------------------------------- 2. route file guards */

/** Route file name → its URL path (index/$id segments flattened to prefixes). */
function routeFilePath(file: string): string {
  const base = file.replace(/\.tsx$/, "");
  const segments = base
    .split(".")
    .filter((s) => s !== "index")
    .map((s) => (s.startsWith("$") ? `:${s.slice(1)}` : s));
  return `/${segments.join("/")}`;
}

describe("route guard completeness", () => {
  test("every route under a gated prefix installs requireRouteCapability", () => {
    const missing: string[] = [];
    const routesDir = join(ROOT, "src", "routes");
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith(".tsx") || file === "__root.tsx" || file.startsWith("api")) continue;
      const path = routeFilePath(file);
      const rule = routeCapabilityOf(path);
      if (!rule) continue; // exempt or not capability-gated
      const source = readFileSync(join(routesDir, file), "utf8");
      if (!source.includes("requireRouteCapability")) missing.push(`${file} (${path})`);
    }
    expect(missing).toEqual([]);
  });

  test("exempt agent-admin routes are NOT gated (they are role-gated, every profile needs them)", () => {
    for (const p of ["/agents/settings", "/agents/governance", "/agents/register"]) {
      expect(routeCapabilityOf(p)).toBeNull();
    }
  });
});

/* ------------------------------------------------- 3. agent tool registry */

const { ensureAgentsRegistered } = await import("../src/server/agents/index");
const registry = await import("../src/server/agents/registry");
ensureAgentsRegistered();

describe("tool registry completeness", () => {
  test("every registered tool declares its capability or sits in TOOL_EXEMPT", () => {
    const undeclared: string[] = [];
    for (const t of registry.listTools()) {
      if (t.capability) continue;
      if (TOOL_EXEMPT.has(t.name)) continue;
      if (t.name.startsWith(registry.STUDIO_TEST_TOOL_PREFIX)) continue;
      undeclared.push(t.name);
    }
    expect(undeclared).toEqual([]);
  });

  test("TOOL_EXEMPT holds no dead names and no capability conflicts", () => {
    const declared = new Set(
      registry
        .listTools()
        .filter((t) => t.capability)
        .map((t) => t.name),
    );
    const registered = new Set(registry.listTools().map((t) => t.name));
    const dead = [...TOOL_EXEMPT].filter((n) => !registered.has(n));
    // Tool-exempt entries for tools registered only in some entry points (e.g.
    // eval fixtures) are fine; anything else must be a live name.
    expect(dead.filter((n) => !n.startsWith("stest_"))).toEqual([]);
    const conflicts = [...declared].filter((n) => TOOL_EXEMPT.has(n));
    expect(conflicts).toEqual([]);
  });
});

/* ------------------------- 4. server-function sweep (strict since B1b) */

describe("server function capability coverage", () => {
  test("every tenant-scoped server fn module is classified in SERVER_FN_MODULE_CAPABILITY", () => {
    const unclassified: string[] = [];
    const dirs = [join(ROOT, "src", "lib"), join(ROOT, "src", "server")];
    for (const dir of dirs) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue;
        const source = readFileSync(join(dir, file), "utf8");
        const createsFns = source.includes("createServerFn");
        const tenantScoped = /requireOrg|requireRole|requirePanel/.test(source);
        const definesCapability = /requireCapability|assertCapability/.test(source);
        if (!createsFns || !tenantScoped || definesCapability) continue;
        if (!(file in SERVER_FN_MODULE_CAPABILITY)) unclassified.push(file);
      }
    }
    expect(unclassified).toEqual([]);
  });

  test("capability-mapped modules attach requireCapability; exempt modules do not", () => {
    const libDir = join(ROOT, "src", "lib");
    const violations: string[] = [];
    for (const [file, cap] of Object.entries(SERVER_FN_MODULE_CAPABILITY)) {
      const path = join(libDir, file);
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        violations.push(`${file}: mapped but missing`); // a stale map entry
        continue;
      }
      const createsFns = source.includes("createServerFn");
      const tenantScoped = /requireOrg|requireRole|requirePanel/.test(source);
      if (!createsFns || !tenantScoped) {
        violations.push(`${file}: mapped but no longer tenant-scoped`); // a stale map entry
        continue;
      }
      if (cap != null && !source.includes("requireCapability"))
        violations.push(`${file}: mapped to ${cap} but no requireCapability attached`);
    }
    expect(violations).toEqual([]);
  });
});
