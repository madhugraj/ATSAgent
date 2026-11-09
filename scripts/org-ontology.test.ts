/**
 * Organisation ontology engine (src/lib/org-ontology.ts): domain packs follow
 * the organisation's industry, requisitions one role explains stay with that
 * role, and a bundle two roles explain together is detected as an emerging
 * role — named from the real titles, born from both parents, moving from
 * signal to emerging to established as requisitions accumulate, and
 * established at once when a person has confirmed it into job architecture.
 */
import { describe, expect, test } from "bun:test";

import { buildOrgOntology, domainOf, findRoleProfile } from "../src/lib/org-ontology";

const NOW = new Date("2026-11-15T00:00:00Z");
const monthsAgo = (n: number) => new Date(Date.UTC(2026, 10 - n, 10));
let seq = 0;
const req = (title: string, skills: string[], ago: number) => ({
  id: `r${++seq}`,
  title,
  skills,
  createdAt: monthsAgo(ago),
});

describe("domain", () => {
  test("industry picks the seed pack", () => {
    expect(domainOf("Hospital & healthcare")).toBe("healthcare");
    expect(domainOf("Automotive manufacturing")).toBe("manufacturing");
    expect(domainOf("Retail banking")).toBe("bfsi");
    expect(domainOf(null)).toBe("tech");
  });
});

describe("role emergence (technology)", () => {
  const AI = ["Python", "LLM", "RAG", "REST APIs", "Microservices", "Pandas"];
  const reqs = [
    req("Senior Backend Engineer", ["Java", "Spring", "REST APIs", "SQL"], 10),
    req("Backend Engineer", ["Java", "Spring Boot", "Microservices", "SQL"], 3),
    // AI engineer: asked for steadily over seven months
    ...[8, 7, 6, 5, 4, 3, 2].map((m) => req(m % 2 ? "AI Engineer" : "Senior AI Engineer", AI, m)),
    // frontend + devops, only twice so far
    req("Frontend Platform Engineer", ["React", "TypeScript", "Kubernetes", "CI/CD", "Docker"], 1),
    req("Frontend Platform Engineer", ["Next.js", "TypeScript", "Docker", "CI/CD", "AWS"], 0),
  ];
  const o = buildOrgOntology({
    industry: "IT services",
    requisitions: reqs,
    candidates: [{ skills: AI, createdAt: monthsAgo(1) }],
    confirmedTitles: [],
    now: NOW,
  });

  test("a requisition one role explains stays with that role", () => {
    expect(o.roles.find((r) => r.id === "backend")?.demand).toBe(2);
    expect(o.emerging.some((e) => /backend/i.test(e.name))).toBe(false);
  });

  test("backend + data science is detected as an emerging AI engineer", () => {
    const ai = o.emerging.find((e) => e.name === "AI Engineer");
    expect(ai).toBeDefined();
    expect(ai!.parents.sort()).toEqual(["backend", "data-scientist"]);
    expect(ai!.status).toBe("established"); // 7 requisitions across 6 months
    expect(ai!.emerging).not.toBeNull();
    expect(ai!.demand.at(-1)).toBe(7);
    expect(ai!.supply).toBe(1);
  });

  test("frontend + devops with two requisitions is an early signal", () => {
    const fde = o.emerging.find((e) => e.name === "Frontend Platform Engineer");
    expect(fde?.parents.sort()).toEqual(["devops", "frontend"]);
    expect(fde?.status).toBe("signal");
  });

  test("a role a person confirmed is established at once", () => {
    const c = buildOrgOntology({
      industry: "IT services",
      requisitions: reqs,
      candidates: [],
      confirmedTitles: ["Frontend Platform Engineer"],
      now: NOW,
    });
    const fde = c.emerging.find((e) => e.name === "Frontend Platform Engineer");
    expect(fde?.confirmed).toBe(true);
    expect(fde?.status).toBe("established");
  });
});

describe("role emergence (healthcare)", () => {
  test("clinical + data analysis is detected as a clinical data analyst", () => {
    const reqs = [3, 2, 1].map((m) =>
      req(
        "Clinical Data Analyst",
        ["Patient care", "EHR charting", "Statistics", "Dashboards", "SQL"],
        m,
      ),
    );
    const o = buildOrgOntology({
      industry: "Healthcare",
      requisitions: reqs,
      candidates: [],
      confirmedTitles: [],
      now: NOW,
    });
    expect(o.domain.key).toBe("healthcare");
    const cda = o.emerging.find((e) => e.name === "Clinical Data Analyst");
    expect(cda?.parents.sort()).toEqual(["data-analyst", "nurse"]);
    expect(cda?.status).toBe("emerging");
    expect(o.families.some((f) => f.name === "Clinical")).toBe(true);
  });
});

describe("role emergence (manufacturing)", () => {
  test("automation + data analysis is detected as an industrial IoT engineer", () => {
    const reqs = [4, 3, 2, 1].map((m) =>
      req(
        "Industrial IoT Engineer",
        ["PLC", "SCADA", "IoT sensors", "Edge computing", "Time-series", "Python"],
        m,
      ),
    );
    const o = buildOrgOntology({
      industry: "Automotive manufacturing",
      requisitions: reqs,
      candidates: [],
      confirmedTitles: [],
      now: NOW,
    });
    const iiot = o.emerging.find((e) => e.name === "Industrial IoT Engineer");
    expect(iiot?.parents.sort()).toEqual(["automation", "data-analyst"]);
    expect(iiot?.status).toBe("emerging");
  });
});

describe("role lookup", () => {
  const AI = ["Python", "LLM", "RAG", "REST APIs", "Microservices", "Pandas"];
  const o = buildOrgOntology({
    industry: "IT services",
    requisitions: [6, 5, 4, 3].map((m) => req("AI Engineer", AI, m)),
    candidates: [],
    confirmedTitles: [],
    now: NOW,
  });

  test("a forward deployment resource resolves to the forward deployed engineer", () => {
    const p = findRoleProfile(o, "I need a forward deployment resource");
    expect(p?.name).toBe("Forward deployed engineer");
    expect(p?.kind).toBe("starter");
    expect(p?.mustHave).toContain("Customer workshops and discovery");
    expect(p?.families).toContain("Client delivery");
  });

  test("a role the organisation is growing resolves to the emerging role", () => {
    const p = findRoleProfile(o, "AI engineer");
    expect(p?.kind).toBe("emerging");
    expect(p?.bornFrom.length).toBe(2);
    expect(p?.requisitions).toBe(4);
  });

  test("an unrelated request finds nothing", () => {
    expect(findRoleProfile(o, "pastry chef")).toBeNull();
  });
});
