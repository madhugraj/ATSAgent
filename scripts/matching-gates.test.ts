/**
 * The score's hard gates and the talent-pool band, both pure:
 * a weighted average expresses emphasis, not licence — an experience band the
 * candidate plainly fails caps the recommendation and ranks them last, a
 * fresher band (max 0) is literal, never "no limit", and the scorer's per-JD
 * level verdict gates on its own rather than any fixed years rule.
 * Run: bun test scripts/matching-gates.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  EXPERIENCE_BAND_GATE,
  experienceScore,
  gatedRecommendation,
  type ExperienceFit,
} from "../src/lib/matching.server";
import { rankPool } from "../src/server/agents/talent-search.server";
import { weightsProblem } from "../src/lib/requisitions.server";

const DEFAULT_W = {
  skills: 40,
  experience: 15,
  career: 10,
  impact: 10,
  education: 10,
  social: 15,
};
type CustomWeight = { key: string; label: string; hint: string; weight: number };

describe("gatedRecommendation", () => {
  const gate = (
    over: {
      injectionSuspected?: boolean;
      experienceScore?: number;
      levelMismatch?: boolean;
      directionMismatch?: boolean;
      ctcOverBand?: boolean;
    } = {},
  ) => ({
    injectionSuspected: false,
    experienceScore: 100,
    levelMismatch: false,
    directionMismatch: false,
    ctcOverBand: false,
    ...over,
  });

  test("a strong in-band candidate is selected", () => {
    expect(gatedRecommendation(80, gate({ experienceScore: 82 }))).toBe("select");
  });

  test("a 19-year VP against a fresher band keeps the score but never auto-selects", () => {
    // The Madhu case (REQ-2026-002, band 0–0): overall 80 from skills,
    // education and impact must not outweigh a failed band.
    const experience = experienceScore(19, 0, 0);
    expect(experience).toBe(0);
    expect(gatedRecommendation(80, gate({ experienceScore: experience }))).toBe("hold");
  });

  test("the gate holds at the threshold and just above the band's grace", () => {
    expect(gatedRecommendation(90, gate({ experienceScore: EXPERIENCE_BAND_GATE }))).toBe("hold");
    expect(gatedRecommendation(90, gate({ experienceScore: EXPERIENCE_BAND_GATE + 1 }))).toBe(
      "select",
    );
  });

  test("the model's per-JD level verdict gates on its own — no fixed years rule", () => {
    // Years inside the band's grace, but the JD hires a fresher and the CV is
    // a staff engineer's: the scorer's structured verdict holds it.
    expect(gatedRecommendation(90, gate({ levelMismatch: true }))).toBe("hold");
    // And "within" never gates by itself.
    expect(gatedRecommendation(90, gate())).toBe("select");
  });

  test("a broken (NaN) score never selects — a person reads it", () => {
    expect(gatedRecommendation(Number.NaN, gate())).toBe("hold");
    expect(gatedRecommendation(Number.NaN, gate({ experienceScore: 0 }))).not.toBe("select");
  });

  test("the career-direction verdict gates on its own", () => {
    // The Sairam case: an AI/voice engineer with real Node.js depth against a
    // backend JD — the skills score credits the evidence, the direction verdict
    // keeps a person in the loop.
    expect(gatedRecommendation(92, gate({ directionMismatch: true }))).toBe("hold");
  });

  test("the band decays symmetrically: years over cost what years under cost", () => {
    // The Madhana Gopal case (REQ-2026-001, band 2–4): 1.3 years over used to
    // cost 13 (10/yr); now, like the under side, it costs 22/yr.
    expect(experienceScore(5.3, 2, 4)).toBe(71);
    expect(experienceScore(4.2, 2, 4)).toBe(96); // a slight overshoot still fits
    // Experience and pay move together: two years over costs what two under do.
    expect(experienceScore(6, 2, 4)).toBe(experienceScore(0, 2, 4));
  });

  test("an ask above the approved band gates; a missing ask never gates", () => {
    // Auto-shortlisting someone the band cannot pay sets up an offer exception;
    // a person decides first.
    expect(gatedRecommendation(90, gate({ ctcOverBand: true }))).toBe("hold");
    expect(gatedRecommendation(90, gate())).toBe("select");
  });

  test("being far under the band gates too", () => {
    // Band 2–4, candidate with 0 years: 100 − 2×22 = 56 — under, not gated.
    expect(experienceScore(0, 2, 4)).toBe(56);
    expect(gatedRecommendation(85, gate({ experienceScore: 56 }))).toBe("select");
    // Band 5–7, candidate with 0 years: 5 years under decays to 0 — gated.
    expect(experienceScore(0, 5, 7)).toBeLessThanOrEqual(EXPERIENCE_BAND_GATE);
    expect(gatedRecommendation(85, gate({ experienceScore: experienceScore(0, 5, 7) }))).toBe(
      "hold",
    );
  });

  test("injection and sub-threshold scores behave as before", () => {
    expect(gatedRecommendation(90, gate({ injectionSuspected: true }))).toBe("hold");
    expect(gatedRecommendation(70, gate())).toBe("hold");
    expect(gatedRecommendation(40, gate({ experienceScore: 0 }))).toBe("reject");
  });
});

describe("the scorer's verdicts are shaped for every JD", () => {
  test("experience_fit accepts each verdict and falls back to within", async () => {
    const { ScoreAiSchema } = await import("../src/lib/matching.server");
    const fits: ExperienceFit[] = ["within", "overqualified", "underqualified"];
    for (const experience_fit of fits)
      expect(ScoreAiSchema.parse({ experience_fit }).experience_fit).toBe(experience_fit);
    // A missing or nonsensical verdict never gates by itself.
    expect(ScoreAiSchema.parse({}).experience_fit).toBe("within");
    expect(ScoreAiSchema.parse({ experience_fit: "intern" }).experience_fit).toBe("within");
  });

  test("direction_fit accepts both verdicts and falls back to aligned", async () => {
    const { ScoreAiSchema } = await import("../src/lib/matching.server");
    expect(ScoreAiSchema.parse({ direction_fit: "aligned" }).direction_fit).toBe("aligned");
    expect(ScoreAiSchema.parse({ direction_fit: "different_direction" }).direction_fit).toBe(
      "different_direction",
    );
    // Missing or garbage never gates by itself.
    expect(ScoreAiSchema.parse({}).direction_fit).toBe("aligned");
    expect(ScoreAiSchema.parse({ direction_fit: "backend" }).direction_fit).toBe("aligned");
  });
});

describe("rankPool experience band", () => {
  const groups = [{ skill: "Python", terms: ["Python"] }];
  const person = (name: string, years: number) => ({
    candidateId: name,
    name,
    experienceYears: years,
    location: "Chennai",
    skills: ["Python"],
    resumeText: "",
    currentEmployer: null,
  });

  test("a fresher band (0–0) is literal: seniors rank below freshers", () => {
    const ranked = rankPool(
      [person("Veteran", 19), person("Fresher", 0.5), person("Near", 2)],
      groups,
      { experienceMin: 0, experienceMax: 0, location: "Chennai" },
    );
    expect(ranked.map((r) => r.name)).toEqual(["Fresher", "Near", "Veteran"]);
    expect(ranked[0]!.inBand).toBe(true);
    expect(ranked.at(-1)!.inBand).toBe(false);
    expect(ranked.at(-1)!.why).toMatch(/outside the band/);
  });

  test("the band's grace is three years on both edges", () => {
    const ranked = rankPool([person("Edge", 3), person("Over", 3.1)], groups, {
      experienceMin: 0,
      experienceMax: 0,
      location: null,
    });
    const byName = new Map(ranked.map((r) => [r.name, r]));
    expect(byName.get("Edge")!.inBand).toBe(true);
    expect(byName.get("Over")!.inBand).toBe(false);
  });

  test("a mid-career band keeps rejecting outside candidates on both edges", () => {
    const ranked = rankPool(
      [person("Junior", 1.2), person("Fit", 3), person("Senior", 9)],
      groups,
      { experienceMin: 2, experienceMax: 4, location: null },
    );
    const byName = new Map(ranked.map((r) => [r.name, r]));
    expect(byName.get("Fit")!.inBand).toBe(true);
    expect(byName.get("Junior")!.inBand).toBe(true); // within the one-year grace under
    expect(byName.get("Senior")!.inBand).toBe(false);
    expect(ranked[0]!.name).toBe("Fit");
  });
});

describe("custom scoring dimensions", () => {
  const dim = (over: Partial<CustomWeight> = {}): CustomWeight => ({
    key: "open_source",
    label: "Open-source contributions",
    hint: "Maintains or contributes to open-source packages, with commits and releases",
    weight: 10,
    ...over,
  });

  test("custom weights join the total-100 rule and are capped at four", () => {
    // 90 built-in + 10 custom = 100: fine.
    expect(weightsProblem({ ...DEFAULT_W, skills: 30 }, [dim()])).toBeNull();
    // The same weights with no custom dimension no longer total 100.
    expect(weightsProblem({ ...DEFAULT_W, skills: 30 })).toMatch(/must total 100/);
    expect(weightsProblem({ ...DEFAULT_W, skills: 20 }, [dim(), dim({ key: "d2" })])).toBeNull();
    expect(
      weightsProblem({ ...DEFAULT_W, skills: 10 }, [
        dim(),
        dim({ key: "d2" }),
        dim({ key: "d3" }),
        dim({ key: "d4" }),
        dim({ key: "d5" }),
      ]),
    ).toMatch(/At most 4/);
  });

  test("keys are slugs, labels are required, hints are real instructions", () => {
    expect(weightsProblem({ ...DEFAULT_W, skills: 30 }, [dim({ key: "Bad Key" })])).toMatch(
      /lowercase/,
    );
    expect(
      weightsProblem({ ...DEFAULT_W, skills: 30 }, [dim({ key: "oss", label: "  " })]),
    ).toMatch(/label/);
    expect(weightsProblem({ ...DEFAULT_W, skills: 30 }, [dim({ hint: "short" })])).toMatch(
      /scoring hint/,
    );
    expect(
      weightsProblem({ ...DEFAULT_W, skills: 30 }, [dim(), dim({ key: "open_source" })]),
    ).toMatch(/duplicated/);
  });
});
