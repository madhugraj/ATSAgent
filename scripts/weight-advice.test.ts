/**
 * Weight advice normalisation (src/lib/weight-advice.ts): whatever the model
 * returns, the advice applied to a requisition is whole numbers totalling
 * exactly 100, with at most two well-formed custom dimensions that pass the
 * same rules the save path enforces.
 * Run: bun test scripts/weight-advice.test.ts
 */
import { describe, expect, test } from "bun:test";

import { weightsProblem } from "../src/lib/requisitions.server";
import { normaliseAdvice, WEIGHT_KEYS } from "../src/lib/weight-advice";

const total = (a: ReturnType<typeof normaliseAdvice>) =>
  WEIGHT_KEYS.reduce((s, k) => s + a[k], 0) + a.customDimensions.reduce((s, d) => s + d.weight, 0);
const valid = (a: ReturnType<typeof normaliseAdvice>) =>
  weightsProblem(
    Object.fromEntries(WEIGHT_KEYS.map((k) => [k, a[k]])) as never,
    a.customDimensions,
  );

describe("normaliseAdvice", () => {
  test("lab technician split with a compliance and location dimension", () => {
    const a = normaliseAdvice(
      {
        skills: 25, experience: 20, career: 5, impact: 5, education: 30, social: 0,
        custom_dimensions: [
          { label: "Regulatory & safety compliance", hint: "GLP, NABL or ISO 15189 work evidenced in the CV", weight: 10 },
          { label: "Location fit", hint: "Lives in or will relocate to Chennai for onsite shifts", weight: 5 },
        ],
        rationale: "Licence-bound role.",
        notes: ["a"],
      },
      ["Organisation profile (version 2)"],
    );
    expect(total(a)).toBe(100);
    expect(a.education).toBeGreaterThan(a.social);
    expect(a.customDimensions.map((d) => d.key)).toEqual([
      "regulatory_safety_compliance",
      "location_fit",
    ]);
    expect(a.basis).toEqual(["Organisation profile (version 2)"]);
    expect(valid(a)).toBeNull();
  });

  test("weights that do not total 100 are rescaled to exactly 100", () => {
    const a = normaliseAdvice({ skills: 40, experience: 40, career: 10, impact: 10, education: 10, social: 7 });
    expect(total(a)).toBe(100);
    expect(valid(a)).toBeNull();
  });

  test("at most two custom dimensions; malformed ones are dropped", () => {
    const a = normaliseAdvice({
      skills: 40, experience: 20, career: 10, impact: 10, education: 5, social: 5,
      custom_dimensions: [
        { label: "", hint: "no label here at all", weight: 5 },
        { label: "Too short", hint: "short", weight: 5 },
        { label: "Equipment expertise", hint: "Named vehicle platforms serviced hands-on", weight: 5 },
        { label: "Equipment expertise", hint: "Duplicate label gets a distinct key", weight: 5 },
        { label: "Third", hint: "Should be dropped as the cap is two", weight: 5 },
      ],
    });
    expect(a.customDimensions).toHaveLength(2);
    expect(new Set(a.customDimensions.map((d) => d.key)).size).toBe(2);
    expect(total(a)).toBe(100);
    expect(valid(a)).toBeNull();
  });

  test("garbage output falls back to a valid even-handed split", () => {
    const a = normaliseAdvice({ skills: "x", experience: Number.NaN });
    expect(total(a)).toBe(100);
    expect(a.customDimensions).toEqual([]);
    expect(valid(a)).toBeNull();
  });
});
