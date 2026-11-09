/**
 * Run the matching-eval scenarios against a live model.
 *
 *   DATABASE_URL=postgres://...127.0.0.1... SESSION_SECRET=... \
 *   EVAL_PROVIDER=openai|anthropic|google EVAL_API_KEY=... EVAL_MODEL=... \
 *   bun scripts/matching-eval.ts
 *
 * EVAL_ONLY=<text> runs only the scenarios whose name contains it.
 *
 * Like scripts/agent-eval.ts: a throwaway organisation per run on a local
 * database; the key is a test key supplied by the person running the eval and
 * is never stored (it travels as an explicit config to the gateway). Every
 * call is still logged to ai_usage_events so the measurements are auditable.
 * Exits non-zero when any scenario fails.
 */
const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run evals against a non-local database");
}
const provider = process.env.EVAL_PROVIDER as "openai" | "anthropic" | "google" | undefined;
const apiKey = process.env.EVAL_API_KEY;
const model = process.env.EVAL_MODEL;
if (!provider || !apiKey || !model) {
  console.error("Set EVAL_PROVIDER, EVAL_API_KEY and EVAL_MODEL to run live matching evals.");
  process.exit(2);
}

const { db, sql } = await import("../src/server/db");
const { eq } = await import("drizzle-orm");
const { organizations } = await import("@db/schema");
const { scoreCandidate, DEFAULT_WEIGHTS } = await import("../src/lib/matching.server");
const { matchingScenarios } = await import("./evals/matching-scenarios");

const [org] = await db
  .insert(organizations)
  .values({
    name: "Matching eval (throwaway)",
    slug: `matching-eval-${Date.now().toString(36)}`,
  })
  .returning({ id: organizations.id });

let failed = 0;
const only = process.env["EVAL_ONLY"]?.toLowerCase();
const scenarios = matchingScenarios().filter((s) => !only || s.name.toLowerCase().includes(only));
for (const s of scenarios) {
  try {
    const result = await scoreCandidate({
      jd: {
        title: s.jd.title,
        mustHave: s.jd.mustHave,
        goodToHave: s.jd.goodToHave ?? [],
        responsibilities: null,
        education: s.jd.education ?? null,
        experienceMin: s.jd.experienceMin,
        experienceMax: s.jd.experienceMax,
        jdText: s.jd.jdText,
        constraints: s.jd.constraints ?? null,
      },
      candidate: {
        name: s.candidate.name,
        skills: s.candidate.skills,
        experienceYears: s.candidate.experienceYears,
        education: s.candidate.education ?? null,
        resumeText: s.candidate.resumeText,
        expectedCtc: s.candidate.expectedCtc ?? null,
        location: s.candidate.location ?? null,
      },
      weights: (s.weights ?? DEFAULT_WEIGHTS) as typeof DEFAULT_WEIGHTS,
      customDimensions: s.customDimensions,
      includeSocial: false,
      orgId: org!.id,
      aiConfig: { provider, model, apiKey },
    });
    const failures = s.expect(result);
    if (!Number.isFinite(result.overall_score))
      failures.unshift(
        `overall_score is ${result.overall_score} — a score must always be a finite number`,
      );
    if (failures.length) failed++;
    console.log(
      `${failures.length ? "FAIL" : "PASS"}  ${s.name}\n      ` +
        `overall=${result.overall_score} exp=${result.experience_score} fit=${result.experience_fit} ` +
        `rec=${result.recommendation} injection=${result.injection_suspected}` +
        (failures.length ? `\n${failures.map((f) => `      ✗ ${f}`).join("\n")}` : ""),
    );
  } catch (e) {
    failed++;
    console.log(`FAIL  ${s.name}\n      ✗ scorer error: ${e instanceof Error ? e.message : e}`);
  }
}
await db.delete(organizations).where(eq(organizations.id, org!.id));
await sql.end();
console.log(`\n${scenarios.length - failed}/${scenarios.length} matching scenarios passed`);
process.exit(failed ? 1 : 0);
