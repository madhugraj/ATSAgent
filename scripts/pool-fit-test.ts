/**
 * One-off: hypothetical JD scored against the plausible pool candidates
 * (evidence-filtered by band and skills). Dry-run — no writes to the database.
 * Run: DATABASE_URL=... SESSION_SECRET=... bun scripts/pool-fit-test.ts
 */
import { and, eq, inArray } from "drizzle-orm";

import { db, sql } from "../src/server/db";
import { candidates } from "@db/schema";
import { DEFAULT_WEIGHTS, harvestProfileLinks, scoreCandidate } from "../src/lib/matching.server";

const jd = {
  title: "Full Stack Developer",
  mustHave: ["React", "Node.js", "TypeScript", "REST APIs", "PostgreSQL", "Docker"],
  goodToHave: ["Next.js", "AWS", "System design", "CI/CD", "MongoDB"],
  responsibilities:
    "Build and operate web applications end to end — React front end, Node.js services, " +
    "relational schemas, REST APIs, containerised deploys.",
  education: null,
  experienceMin: 4,
  experienceMax: 8,
  jdText:
    "Full Stack Developer (4–8 years). You will build and operate web applications end to " +
    "end: React front end, Node.js/TypeScript services, PostgreSQL schemas, REST APIs, " +
    "Docker. Good-to-have: Next.js, AWS, system design, CI/CD, MongoDB.",
  constraints: { locations: ["Chennai", "Coimbatore"] },
};

const names = ["Praveen Kumar G", "UDHAYAKUMAR C"];

const rows = await db
  .select()
  .from(candidates)
  .where(and(eq(candidates.poolUse, "pool"), inArray(candidates.fullName, names)));

const results: { name: string; yrs: number; line: string }[] = [];
for (const cand of rows) {
  const links = harvestProfileLinks(cand.resumeText);
  try {
    const r = await scoreCandidate({
      jd,
      candidate: {
        name: cand.fullName,
        skills: cand.skills ?? [],
        experienceYears: Number(cand.experienceYears ?? 0),
        education: cand.education ?? null,
        resumeText: cand.resumeText,
        linkedinUrl: cand.linkedinUrl ?? links.linkedinUrl,
        githubUrl: cand.githubUrl ?? links.githubUrl,
        location: cand.location ?? null,
      },
      weights: DEFAULT_WEIGHTS,
      includeSocial: false,
      orgId: "88bc4140-f8d7-4a5e-8bcd-5343556d3cdf",
    });
    results.push({
      name: cand.fullName,
      yrs: Number(cand.experienceYears ?? 0),
      line: `overall=${r.overall_score} skl=${r.skills_score} exp=${r.experience_score} edu=${r.education_score} career=${r.career_score} | level=${r.experience_fit} direction=${r.direction_fit} -> ${r.recommendation} | ${r.rationale.slice(0, 220)}`,
    });
  } catch (e) {
    results.push({
      name: cand.fullName,
      yrs: Number(cand.experienceYears ?? 0),
      line: `ERROR ${e instanceof Error ? e.message.slice(0, 160) : e}`,
    });
  }
}
results.sort((a, b) => b.yrs - a.yrs);
for (const r of results) console.log(`\n${r.name} · ${r.yrs}y\n  ${r.line}`);
await sql.end();
