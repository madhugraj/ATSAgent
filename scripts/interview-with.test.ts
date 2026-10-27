import { expect, test } from "bun:test";

import { interviewWith } from "../src/lib/interview-with";

test("who an interview is with — never a name", () => {
  expect(interviewWith(0)).toBe("the hiring team");
  expect(interviewWith(1)).toBe("the hiring team");
  expect(interviewWith(3)).toBe("a panel of 3 from the hiring team");
});
