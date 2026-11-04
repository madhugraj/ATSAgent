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

describe("gatedRecommendation", () => {
  const gate = (
    over: {
      injectionSuspected?: boolean;
      experienceScore?: number;
      levelMismatch?: boolean;
    } = {},
  ) => ({
    injectionSuspected: false,
    experienceScore: 100,
    levelMismatch: false,
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

describe("the scorer's experience_fit verdict is shaped for every JD", () => {
  test("the schema accepts each verdict and falls back to within", async () => {
    const { ScoreAiSchema } = await import("../src/lib/matching.server");
    const fits: ExperienceFit[] = ["within", "overqualified", "underqualified"];
    for (const experience_fit of fits)
      expect(ScoreAiSchema.parse({ experience_fit }).experience_fit).toBe(experience_fit);
    // A missing or nonsensical verdict never gates by itself.
    expect(ScoreAiSchema.parse({}).experience_fit).toBe("within");
    expect(ScoreAiSchema.parse({ experience_fit: "intern" }).experience_fit).toBe("within");
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
