/**
 * The voice agents' charter holds: every rule is in the agent's instructions,
 * the manifest's must-never list is the charter's, the doc matches, and no
 * member of staff can reach a call. Pure — no database.
 * Run: bun test scripts/voice-charter.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const charter = await import("../src/server/voice/charter");
const registry = await import("../src/server/agents/registry");
const defs = await import("../src/server/agents/definitions");
const { charterDoc } = await import("./voice-charter-doc");

registry.resetRegistry();
defs.registerPhase1Agents();
defs.registerPhase2Agents();
defs.registerPhase3Agents();

const CHARTERS = [charter.SCREENING_CALL_CHARTER, charter.SCHEDULING_CALL_CHARTER];

describe("the voice agents' charter", () => {
  for (const ch of CHARTERS) {
    test(`${ch.agent}: every rule is in its instructions; must-never is the charter's`, () => {
      const def = registry.getAgent(ch.agent)!;
      expect(def).toBeTruthy();
      for (const r of [...ch.mustSay, ...ch.may, ...ch.mustNot, ...ch.handOff, ...ch.tone])
        expect(def.system).toContain(r.rule);
      expect(def.system).toContain(ch.purpose);
      expect(def.mustNever).toEqual(charter.mustNeverOf(ch));
    });
  }

  test("staff are confidential in both charters", () => {
    for (const ch of CHARTERS)
      expect(ch.mustNot.map((r) => r.rule).join(" ")).toMatch(
        /Name or describe any member of staff — the hiring manager, recruiters or the interview panel/,
      );
  });

  test("docs/voice-agents-charter.md is the charter (run bun scripts/voice-charter-doc.ts)", () => {
    const doc = readFileSync(new URL("../docs/voice-agents-charter.md", import.meta.url), "utf8");
    expect(doc).toBe(charterDoc());
  });
});
