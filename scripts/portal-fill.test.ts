/**
 * The companion's portal form filler (extension/portal-fill.js): which role
 * field each portal label asks for. Pure — the DOM filling is checked by hand
 * against the real Internshala and Apna forms.
 * Run: bun test scripts/portal-fill.test.ts
 */
import { describe, expect, test } from "bun:test";

const { atsiqFieldKey } = (await import("../extension/portal-fill.js")) as unknown as {
  atsiqFieldKey: (t: string) => string | null;
};

describe("portal labels", () => {
  test.each([
    ["Job title*", "title"],
    ["Internship profile", "title"],
    ["Job role", "title"],
    ["Designation", "title"],
    ["City / Location", "location"],
    ["Number of openings", "openings"],
    ["No. of vacancies", "openings"],
    ["Minimum experience (years)", "expMin"],
    ["Maximum experience", "expMax"],
    ["Experience required", "experience"],
    ["Skills required", "skills"],
    ["Job description", "description"],
    ["Intern's responsibilities", "description"],
    ["Work from home / office", "workMode"],
    ["External application link (URL)", "applyUrl"],
  ])("%s → %s", (label, key) => {
    expect(atsiqFieldKey(label)).toBe(key);
  });

  test("pay and unknown fields are left to the person", () => {
    for (const label of [
      "Stipend",
      "Salary (CTC)",
      "Perks",
      "Joining fee",
      "Gender preference",
      "",
    ])
      expect(atsiqFieldKey(label)).toBeNull();
  });
});
