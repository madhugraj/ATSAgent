import { describe, expect, test } from "bun:test";

import { bookedTextOf, firstSentence, placeOnly } from "../src/lib/interviewer-brief.server";

describe("interviewer brief", () => {
  test("first sentence instead of a mid-word cut", () => {
    expect(firstSentence("Strong on RAG. Thin on Git ownership.")).toBe("Strong on RAG.");
    expect(firstSentence("No full stop here")).toBe("No full stop here");
    expect(firstSentence("  ")).toBeUndefined();
  });
  test("location without the PIN code", () => {
    expect(placeOnly("Dindigul, Tamil Nadu - 624005")).toBe("Dindigul, Tamil Nadu");
    expect(placeOnly("Bengaluru")).toBe("Bengaluru");
  });
  test("says how the time was set", () => {
    expect(bookedTextOf("candidate (chose the time)")).toBe("Picked by the candidate");
    expect(bookedTextOf("candidate (chose the time on an AI scheduling call)")).toBe(
      "Confirmed by the candidate on a scheduling call",
    );
    expect(bookedTextOf("Madhu")).toContain("Booked by Madhu");
    expect(bookedTextOf(undefined)).toBeUndefined();
  });
});
