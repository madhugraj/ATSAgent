/**
 * Career metrics are measured per employer: promotions inside a company are not
 * job changes, and a role still in progress is never a "short stint".
 * Run: bun test scripts/career-metrics.test.ts
 */
import { describe, expect, test } from "bun:test";

import { careerScore, computeCareerMetrics } from "../src/lib/career";

const now = new Date("2026-10-12T12:00:00Z");

describe("career metrics", () => {
  test("a promotion within one company is progression, not job-hopping", () => {
    const m = computeCareerMetrics(
      [
        {
          company: "Yavar Techworks",
          title: "Vice President - AI Research",
          start: "Apr 2026",
          end: "Present",
        },
        {
          company: "Yavar Techworks",
          title: "Associate Vice President - AI Platforms",
          start: "Jan 2025",
          end: "Mar 2026",
        },
        {
          company: "IKS Health",
          title: "Director - Data Science",
          start: "Sep 2023",
          end: "Dec 2024",
        },
        {
          company: "Accenture",
          title: "Data Science Specialist",
          start: "Sep 2021",
          end: "Sep 2023",
        },
        {
          company: "Standard Chartered Bank",
          title: "Deep Learning Specialist",
          start: "Aug 2020",
          end: "Sep 2021",
        },
        {
          company: "Bank of America",
          title: "Analyst - AI/ML",
          start: "Sep 2019",
          end: "Sep 2020",
        },
        {
          company: "SRM University",
          title: "Research Scholar & Assistant Professor",
          start: "May 2012",
          end: "Jul 2019",
        },
      ] as never,
      { now },
    );
    expect(m.jobs_last_5y).toBe(3); // Yavar, IKS Health, Accenture
    expect(m.dated_employers).toBe(6); // the two Yavar roles are one tenure
    expect(m.current_tenure_years).toBe(1.8); // Jan 2025 → today
    expect(m.shortest_stint_years).toBe(1); // finished tenures only
    const flags = careerScore(m).flags.join(" | ");
    expect(flags).not.toMatch(/shorter than 9 months/);
    expect(flags).not.toMatch(/employers in the last 5 years/);
  });

  test("a current role of a few months is not a short stint", () => {
    const m = computeCareerMetrics(
      [
        { company: "Acme", title: "Head of Product", start: "Jun 2026", end: "Present" },
        { company: "Globex", title: "Director of Product", start: "Jan 2020", end: "May 2026" },
      ] as never,
      { now },
    );
    expect(m.shortest_stint_years).toBe(6.3);
    expect(careerScore(m).flags.join(" ")).not.toMatch(/shorter than 9 months/);
  });

  test("real job-hopping is still flagged", () => {
    const m = computeCareerMetrics(
      [
        { company: "D Corp", title: "Manager", start: "Jan 2026", end: "Present" },
        { company: "C Corp", title: "Manager", start: "Mar 2025", end: "Sep 2025" },
        { company: "B Corp", title: "Lead", start: "Jan 2023", end: "Feb 2025" },
        { company: "A Corp", title: "Lead", start: "Jan 2022", end: "Dec 2022" },
      ] as never,
      { now },
    );
    expect(m.jobs_last_5y).toBe(4);
    const flags = careerScore(m).flags.join(" | ");
    expect(flags).toMatch(/A role shorter than 9 months \(0.5 yrs\)/);
    expect(flags).toMatch(/4 employers in the last 5 years/);
  });

  test("company names compare loosely (suffixes and punctuation)", () => {
    const m = computeCareerMetrics(
      [
        { company: "Yavar Techworks Pvt. Ltd.", title: "VP", start: "Apr 2026", end: "Present" },
        { company: "Yavar Techworks", title: "AVP", start: "Jan 2025", end: "Mar 2026" },
      ] as never,
      { now },
    );
    expect(m.dated_employers).toBe(1);
    expect(m.employers).toBe(1);
  });
});
