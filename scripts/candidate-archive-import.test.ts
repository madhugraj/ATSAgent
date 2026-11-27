/**
 * Archive import (plan rows 3–4, A3): staging rejects unsupported/duplicate
 * files; a trial run reads files without creating candidates and leaves no
 * staged bytes; a real import creates candidates with CV versions through the
 * intake core; re-running skips files the organisation already holds; an
 * organisation at its AI spend cap is deferred without burning attempts.
 *
 * Run: DATABASE_URL=<disposable local db> bun test scripts/candidate-archive-import.test.ts
 */
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
delete process.env["PARSER_URL"];
delete process.env["S3_BUCKET"];

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

// Deterministic "AI": the resume parser reads the name and email lines.
const realGateway = await import("../src/lib/ai-gateway.server");
mock.module("../src/lib/ai-gateway.server", () => ({
  ...realGateway,
  aiJson: async (opts: {
    prompt: string;
    feature: string;
    schema?: { parse: (v: unknown) => unknown };
  }) => {
    const name = opts.prompt.match(/Name: ([^\n<]+)/)?.[1]?.trim() ?? null;
    const email = opts.prompt.match(/Email: ([^\s<]+)/)?.[1]?.trim() ?? null;
    const raw =
      opts.feature === "resume_parse"
        ? { full_name: name, email, skills: ["Sales"], employment_history: [] }
        : { claims: [] };
    return { ok: true, data: opts.schema ? opts.schema.parse(raw) : raw };
  },
}));
let capOn = false;
const realCap = await import("../src/server/ai-spend-cap");
mock.module("../src/server/ai-spend-cap", () => ({
  ...realCap,
  spendCapRefusal: async () => (capOn ? "cap reached" : null),
}));

const { db } = await import("../src/server/db");
const {
  auditLog,
  candidateArchiveImports,
  candidateArchiveItems,
  candidateCvVersions,
  candidates,
  organizations,
} = await import("../drizzle/schema");
const archive = await import("../src/server/candidates/archive-import.server");
const { getObject } = await import("../src/server/storage");

const stamp = Date.now();
let orgA: string;

const cv = (n: number) =>
  new TextEncoder().encode(
    `Name: Person ${n} Archive\nEmail: person${n}-${stamp}@example.test\n` +
      "Account manager with ten years of marketplace seller growth experience across Europe. ".repeat(
        2,
      ),
  );

async function mkImport(trialRun: boolean, trialLimit?: number) {
  return (
    await db
      .insert(candidateArchiveImports)
      .values({ orgId: orgA, name: `t-${trialRun}`, trialRun, trialLimit: trialLimit ?? null })
      .returning()
  )[0]!;
}

async function run(importId: string) {
  await db
    .update(candidateArchiveImports)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(candidateArchiveImports.id, importId));
  for (let i = 0; i < 10; i++) {
    const c = await archive.drainArchiveImports({ limit: 25 });
    if (!c["claimed"]) break;
  }
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname))
    throw new Error("Refusing non-local database");
  orgA = (
    await db
      .insert(organizations)
      .values({ name: "Archive A", slug: `archive-a-${stamp}`, status: "active" })
      .returning({ id: organizations.id })
  )[0]!.id;
});

afterAll(async () => {
  if (orgA) {
    await db.delete(auditLog).where(eq(auditLog.orgId, orgA));
    await db.delete(organizations).where(eq(organizations.id, orgA));
  }
});

describe("staging", () => {
  test("rejects unsupported types and de-duplicates identical files", async () => {
    const imp = await mkImport(false);
    const a = await archive.stageArchiveFile({
      orgId: orgA,
      importId: imp.id,
      fileName: "x.exe",
      bytes: cv(0),
    });
    expect(a.status).toBe("rejected");
    const b = await archive.stageArchiveFile({
      orgId: orgA,
      importId: imp.id,
      fileName: "a.txt",
      bytes: cv(0),
    });
    const c = await archive.stageArchiveFile({
      orgId: orgA,
      importId: imp.id,
      fileName: "copy.txt",
      bytes: cv(0),
    });
    expect(b.status).toBe("staged");
    expect(c.status).toBe("duplicate");
    await archive.finaliseImport(orgA, imp.id, "cancelled");
    const items = await db
      .select()
      .from(candidateArchiveItems)
      .where(eq(candidateArchiveItems.importId, imp.id));
    expect(items.every((i) => i.stagedPath === null)).toBe(true);
  });
});

describe("trial and real import", () => {
  test("a trial reads up to its limit, writes no candidates and keeps no staged bytes", async () => {
    const imp = await mkImport(true, 10);
    const paths: string[] = [];
    for (let n = 1; n <= 12; n++)
      await archive.stageArchiveFile({
        orgId: orgA,
        importId: imp.id,
        fileName: `cv${n}.txt`,
        bytes: cv(n),
      });
    for (const i of await db
      .select()
      .from(candidateArchiveItems)
      .where(eq(candidateArchiveItems.importId, imp.id)))
      paths.push(i.stagedPath!);
    await run(imp.id);
    const people = await db.select().from(candidates).where(eq(candidates.orgId, orgA));
    expect(people).toHaveLength(0);
    const [view] = (await archive.listArchiveImports(orgA)).filter((v) => v.id === imp.id);
    expect(view!.status).toBe("done");
    expect(view!.report!.readable).toBe(10);
    expect(view!.report!.withEmail).toBe(10);
    for (const p of paths) expect(await getObject(p)).toBeNull();
  });

  test("a real import creates candidates with versions; re-running skips held files", async () => {
    const imp = await mkImport(false);
    for (let n = 20; n < 25; n++)
      await archive.stageArchiveFile({
        orgId: orgA,
        importId: imp.id,
        fileName: `cv${n}.txt`,
        bytes: cv(n),
      });
    await run(imp.id);
    const people = await db.select().from(candidates).where(eq(candidates.orgId, orgA));
    expect(people).toHaveLength(5);
    const versions = await db
      .select()
      .from(candidateCvVersions)
      .where(eq(candidateCvVersions.orgId, orgA));
    expect(versions).toHaveLength(5);
    expect(versions.every((v) => v.source === "archive_import")).toBe(true);

    const again = await mkImport(false);
    for (let n = 20; n < 25; n++)
      await archive.stageArchiveFile({
        orgId: orgA,
        importId: again.id,
        fileName: `cv${n}.txt`,
        bytes: cv(n),
      });
    await run(again.id);
    const items = await db
      .select()
      .from(candidateArchiveItems)
      .where(eq(candidateArchiveItems.importId, again.id));
    expect(items.every((i) => i.status === "skipped" && i.candidateId)).toBe(true);
    expect(await db.select().from(candidates).where(eq(candidates.orgId, orgA))).toHaveLength(5);
  });

  test("at the spend cap items are deferred without burning attempts", async () => {
    const imp = await mkImport(false);
    await archive.stageArchiveFile({
      orgId: orgA,
      importId: imp.id,
      fileName: "cap.txt",
      bytes: cv(99),
    });
    await db
      .update(candidateArchiveImports)
      .set({ status: "running" })
      .where(eq(candidateArchiveImports.id, imp.id));
    capOn = true;
    const c = await archive.drainArchiveImports({ limit: 5 });
    capOn = false;
    expect(c["deferred"]).toBe(1);
    const [item] = await db
      .select()
      .from(candidateArchiveItems)
      .where(and(eq(candidateArchiveItems.importId, imp.id)));
    expect(item!.status).toBe("pending");
    expect(item!.attempts).toBe(0);
    await archive.finaliseImport(orgA, imp.id, "cancelled");
  });
});
