/**
 * Skill supply vs demand (Intelligence, governance roles): the skills this
 * organisation's requisitions ask for against the skills its candidate pool
 * holds, built by the production ontology builder. Deterministic, org-scoped.
 */
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import { candidates, requisitions } from "@db/schema";
import { assertRole, requireOrg } from "./auth.middleware";
import { buildOntology } from "./ontology.server";

export type SkillGap = { skill: string; demand: number; supply: number };
export type SkillFix = {
  severity: "act" | "watch";
  what: string;
  why: string;
  agents: string[];
  next: { label: string; to: string };
};
export type SkillSupply = {
  generatedAt: string;
  gaps: SkillGap[];
  fixes: SkillFix[];
  counts: {
    skills: number;
    candidates: number;
    requisitions: number;
    reqsWithSkills: number;
    sourcing: number;
    short: number;
    covered: number;
  };
};

export const skillSupplyDemand = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .handler(async ({ context }): Promise<SkillSupply> => {
    const org = context.orgId;
    await assertRole(context.userId, org, ["hr_head", "president_cbo"]);
    const [candRows, reqRows] = await Promise.all([
      db
        .select({ id: candidates.id, skills: candidates.skills, createdAt: candidates.createdAt })
        .from(candidates)
        .where(eq(candidates.orgId, org)),
      db
        .select({
          id: requisitions.id,
          title: requisitions.title,
          openings: requisitions.openings,
          must: requisitions.mustHaveSkills,
          good: requisitions.goodToHaveSkills,
          status: requisitions.status,
        })
        .from(requisitions)
        .where(eq(requisitions.orgId, org)),
    ]);
    const ont = buildOntology({
      candidates: candRows.map((c) => ({
        candidateId: c.id,
        skills: c.skills ?? [],
        observedAt: c.createdAt.toISOString(),
        hired: false,
        resumeText: null,
      })),
      demand: reqRows.map((r) => ({
        requisitionId: r.id,
        title: r.title ?? "requisition",
        openings: r.openings ?? 1,
        mustHave: (r.must as string[] | null) ?? [],
        goodToHave: (r.good as string[] | null) ?? [],
        open: r.status !== "closed",
      })),
      previous: [],
    });
    const gaps: SkillGap[] = ont.nodes
      .filter((n) => n.demand > 0 || n.supply > 0)
      .map((n) => ({ skill: n.name, demand: n.demand, supply: n.supply }))
      .sort(
        (a, b) =>
          b.demand - b.supply - (a.demand - a.supply) || b.demand - a.demand || b.supply - a.supply,
      )
      .slice(0, 30);
    const sourcing = gaps.filter((g) => g.demand > 0 && g.supply === 0);
    const short = gaps.filter((g) => g.demand > 0 && g.supply > 0 && g.supply < g.demand);
    const covered = gaps.filter((g) => g.demand > 0 && g.supply >= g.demand);
    const reqsWithSkills = reqRows.filter(
      (r) =>
        ((r.must as string[] | null) ?? []).length + ((r.good as string[] | null) ?? []).length > 0,
    ).length;

    const fixes: SkillFix[] = [];
    if (reqRows.length > 0 && reqsWithSkills === 0)
      fixes.push({
        severity: "act",
        what: "No requisition lists its skills",
        why: "Without must-have or good-to-have skills there is nothing to compare your pool against.",
        agents: [],
        next: { label: "Add skills to requisitions", to: "/requisitions" },
      });
    for (const g of sourcing.slice(0, 6))
      fixes.push({
        severity: "act",
        what: `${g.skill}: asked for ${g.demand}×, nobody in your pool`,
        why: "Every open requisition needing this skill depends on new sourcing.",
        agents: [g.skill],
        next: { label: "Source candidates", to: "/candidates" },
      });
    for (const g of short.slice(0, 4))
      fixes.push({
        severity: "watch",
        what: `${g.skill}: ${g.supply} in pool for ${g.demand} asks`,
        why: "Thin cover — one withdrawal leaves a requisition without a candidate.",
        agents: [g.skill],
        next: { label: "Source candidates", to: "/candidates" },
      });
    for (const ins of ont.insights.filter((i) => i.severity !== "low").slice(0, 4))
      fixes.push({
        severity: ins.severity === "high" ? "act" : "watch",
        what: ins.title,
        why: ins.detail,
        agents: ins.skills.slice(0, 3),
        next: { label: ins.actionLabel ?? "Open master data", to: ins.actionTo ?? "/masters" },
      });
    fixes.sort((a, b) => Number(a.severity === "watch") - Number(b.severity === "watch"));

    return {
      generatedAt: new Date().toISOString(),
      gaps,
      fixes,
      counts: {
        skills: ont.stats.nodeCount,
        candidates: candRows.length,
        requisitions: reqRows.length,
        reqsWithSkills,
        sourcing: sourcing.length,
        short: short.length,
        covered: covered.length,
      },
    };
  });
