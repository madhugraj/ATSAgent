/**
 * Pre-interview reminders: which reminder is due, and the dedupe key.
 * Run: bun test scripts/interview-reminders.test.ts
 */
import { describe, expect, test } from "bun:test";

import { reminderKey, reminderStep } from "../src/lib/interview-reminders.server";

describe("reminderStep", () => {
  test("nothing more than a day out, or once the round has started", () => {
    expect(reminderStep(30)).toBeNull();
    expect(reminderStep(0)).toBeNull();
    expect(reminderStep(-1)).toBeNull();
  });
  test("the day reminder inside 24 h, the soon reminder inside 1 h", () => {
    expect(reminderStep(24)).toBe("day");
    expect(reminderStep(5)).toBe("day");
    expect(reminderStep(1)).toBe("soon");
    expect(reminderStep(0.25)).toBe("soon");
  });
  test("no day reminder right after booking (the invite just went out)", () => {
    expect(reminderStep(10, 1)).toBeNull();
    expect(reminderStep(10, 4)).toBe("day");
    // The soon reminder still goes.
    expect(reminderStep(0.5, 0.1)).toBe("soon");
  });
});

describe("reminderKey", () => {
  test("a reschedule re-arms; email case does not matter", () => {
    const a = new Date("2026-11-24T07:30:00Z");
    const b = new Date("2026-11-25T07:30:00Z");
    expect(reminderKey("i1", a, "S@x.ai", "day")).toBe(reminderKey("i1", a, "s@x.ai", "day"));
    expect(reminderKey("i1", a, "s@x.ai", "day")).not.toBe(reminderKey("i1", b, "s@x.ai", "day"));
    expect(reminderKey("i1", a, "s@x.ai", "day")).not.toBe(reminderKey("i1", a, "s@x.ai", "soon"));
  });
});
