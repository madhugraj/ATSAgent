/**
 * Who owes the next words on an AI phone call (src/server/voice/turns.ts) —
 * the one turn manager all three calls share. Pure: a fake clock.
 * Run: bun test scripts/voice-turns.test.ts
 */
import { describe, expect, test } from "bun:test";

const { TurnKeeper, TURN_TIMING, SAYS_NOTED } = await import("../src/server/voice/turns");

function keeper(over: { recordTools?: string[]; speakAfter?: (n: string) => boolean } = {}) {
  let t = 0;
  const sent: string[] = [];
  const k = new TurnKeeper({
    send: (s) => sent.push(s),
    endTools: new Set(["end_call"]),
    recordTools: new Set(over.recordTools ?? ["record_details", "record_answer"]),
    ...(over.speakAfter ? { speakAfter: over.speakAfter } : {}),
    now: () => t,
  });
  /** Let `ms` pass on a quiet line, ticking every 250 ms. */
  const quiet = (ms: number, playing = false) => {
    for (let i = 0; i < ms; i += 250) {
      t += 250;
      k.tick(playing);
    }
  };
  return { k, sent, quiet, at: () => t };
}

describe("the assistant owes the line", () => {
  test("after a tool result: cued once the line is quiet, repeated, then left", () => {
    const { k, sent, quiet } = keeper();
    k.aiAudio();
    k.aiTurn("Thank you.");
    k.tool("record_answer", true);
    quiet(TURN_TIMING.afterToolMs - 250);
    expect(sent).toHaveLength(0);
    quiet(500);
    expect(sent).toEqual([expect.stringMatching(/waiting in silence/)]);
    quiet(TURN_TIMING.repeatMs * 5);
    expect(sent).toHaveLength(TURN_TIMING.maxCues);
    expect(k.counts.after_tool).toBe(TURN_TIMING.maxCues);
  });

  test("audio still playing is not silence; speaking again clears what is owed", () => {
    const { k, sent, quiet } = keeper();
    k.aiAudio();
    k.tool("record_answer", true);
    quiet(10_000, true);
    expect(sent).toHaveLength(0);
    k.aiAudio();
    quiet(10_000);
    expect(sent).toHaveLength(0);
  });

  test("a turn ending on a statement is owed; a question or a goodbye is not", () => {
    const a = keeper();
    a.k.aiAudio();
    a.k.aiTurn("Now for a few practical details.");
    a.quiet(TURN_TIMING.midTurnMs + 250);
    expect(a.sent).toEqual([expect.stringMatching(/You stopped speaking/)]);
    const b = keeper();
    b.k.aiAudio();
    b.k.aiTurn("What is your notice period?");
    b.quiet(15_000);
    expect(b.sent).toHaveLength(0);
    const c = keeper();
    c.k.aiAudio();
    c.k.aiTurn("Thank you for your time. Goodbye.");
    c.quiet(15_000);
    expect(c.sent).toHaveLength(0);
  });

  test("the candidate speaking clears it; when they stop, a reply is owed", () => {
    const { k, sent, quiet } = keeper();
    k.aiAudio();
    k.aiTurn("Now for a few practical details.");
    quiet(1_000);
    k.caller("start", true);
    quiet(1_000, false);
    k.caller("end", false);
    quiet(TURN_TIMING.replyMs - 500);
    expect(sent).toHaveLength(0);
    quiet(750);
    expect(sent).toEqual([expect.stringMatching(/silence on the line/)]);
  });

  test("nothing is owed after the call-ending tool, or before the assistant began", () => {
    const a = keeper();
    a.k.tool("record_answer", true);
    a.quiet(15_000);
    expect(a.sent).toHaveLength(0);
    const b = keeper();
    b.k.aiAudio();
    b.k.tool("end_call", true);
    b.quiet(15_000);
    expect(b.sent).toHaveLength(0);
  });

  test("a refused tool must be spoken on; a quiet result can be configured", () => {
    const a = keeper({ speakAfter: () => false });
    a.k.aiAudio();
    a.k.tool("explain_offer", true);
    a.quiet(10_000);
    expect(a.sent).toHaveLength(0);
    a.k.tool("explain_offer", false);
    a.quiet(TURN_TIMING.afterToolMs + 250);
    expect(a.sent).toHaveLength(1);
  });
});

describe("said it noted it, so it must be recorded", () => {
  test("phrases", () => {
    for (const s of [
      "I'll note that you prefer to discuss pay with HR.",
      "I have noted that.",
      "Noted down, thank you.",
      "I'll pass that on to the hiring team.",
    ])
      expect(SAYS_NOTED.test(s)).toBe(true);
    for (const s of ["Thank you.", "Could you note the time?", "Understood."])
      expect(SAYS_NOTED.test(s)).toBe(false);
  });

  test("no record around it: reminded once; a record just before or soon after covers it", () => {
    const a = keeper();
    a.k.aiAudio();
    a.k.aiTurn("Of course. I'll note that you prefer to discuss pay with the HR team?");
    a.quiet(TURN_TIMING.noteGraceMs + 500);
    expect(a.sent).toEqual([expect.stringMatching(/nothing was recorded/)]);
    expect(a.k.counts.unrecorded_note).toBe(1);

    const b = keeper();
    b.k.aiAudio();
    b.k.tool("record_details", true);
    b.k.aiTurn("Thank you, I have noted that?");
    b.quiet(TURN_TIMING.noteGraceMs + 500);
    expect(b.sent).toHaveLength(0);

    const c = keeper();
    c.k.aiAudio();
    c.k.aiTurn("I'll note that. What is your notice period?");
    c.quiet(2_000);
    c.k.tool("record_details", true);
    c.quiet(TURN_TIMING.noteGraceMs + 500);
    expect(c.sent.filter((s) => /nothing was recorded/.test(s))).toHaveLength(0);
  });
});
