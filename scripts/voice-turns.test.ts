/**
 * Who owes the next words on an AI phone call (src/server/voice/turns.ts) —
 * the one turn manager all three calls share. Pure: a fake clock.
 * Run: bun test scripts/voice-turns.test.ts
 */
import { describe, expect, test } from "bun:test";

const { TurnKeeper, TURN_TIMING, SAYS_NOTED } = await import("../src/server/voice/turns");
const { ReadyGreeting, GREETING_WAIT_MS, greetingCue } =
  await import("../src/server/voice/greeting");
const { TurnDetector, TURN_DETECT } = await import("../src/server/voice/turn-detector");

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
    k.heard(); // the model transcribed them: it waits its usual time
    quiet(TURN_TIMING.replyMs - 500);
    expect(sent).toHaveLength(0);
    quiet(750);
    expect(sent).toEqual([expect.stringMatching(/silence on the line/)]);
  });

  test("the model never heard them (a short 'okay'): cued after 3 s, not 7 (10 November)", () => {
    const { k, sent, quiet } = keeper();
    k.aiAudio();
    k.aiTurn("Is now a good time for a quick 3 minute call?");
    k.caller("start", true);
    quiet(500, false);
    k.caller("end", false);
    quiet(TURN_TIMING.unheardMs - 500);
    expect(sent).toHaveLength(0);
    quiet(750);
    expect(sent).toEqual([expect.stringMatching(/say it again/)]);
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

describe("an answer that runs long", () => {
  test("past the limit: told at their next pause to move on, once per answer", () => {
    const { k, sent, quiet } = keeper();
    k.aiAudio();
    k.aiTurn("Can you walk me through an incident you led?");
    // They talk for 100 s in 20 s stretches with short breaths between.
    for (let i = 0; i < 5; i++) {
      k.caller("start", true);
      quiet(20_000, false);
      k.caller("end", false);
      quiet(500);
    }
    const long = sent.filter((s) => /answer has run long/.test(s));
    expect(long).toHaveLength(1);
    expect(k.counts.long_answer).toBe(1);
  });

  test("under the limit, or a new answer after the assistant spoke: no cue", () => {
    const { k, sent, quiet } = keeper();
    k.aiAudio();
    k.aiTurn("What is your notice period?");
    k.caller("start", true);
    quiet(TURN_TIMING.longAnswerMs - 5_000);
    k.caller("end", false);
    k.aiAudio(); // it replied: the next answer starts afresh
    k.aiTurn("Which date could you join?");
    k.caller("start", true);
    quiet(10_000);
    k.caller("end", false);
    expect(sent.filter((s) => /answer has run long/.test(s))).toHaveLength(0);
  });
});

describe("the planned length runs out", () => {
  test("told to close once, at the first quiet moment after the time, never before pickup", () => {
    let t = 0;
    const sent: string[] = [];
    const k = new TurnKeeper({
      send: (s) => sent.push(s),
      endTools: new Set(["end_call"]),
      closeAfterMs: 150_000,
      now: () => t,
    });
    const tick = (ms: number, playing = false) => {
      for (let i = 0; i < ms; i += 250) {
        t += 250;
        k.tick(playing);
      }
    };
    k.aiAudio();
    tick(200_000); // not answered yet: no close
    expect(sent.filter((s) => /Time is nearly up/.test(s))).toHaveLength(0);
    t = 0;
    k.answered();
    k.aiTurn("What is your expected CTC?");
    tick(140_000, true); // talking the whole time
    k.caller("start", true);
    tick(20_000); // past 150 s, but they are still speaking
    expect(sent.filter((s) => /Time is nearly up/.test(s))).toHaveLength(0);
    k.caller("end", false);
    tick(1_000);
    expect(sent.filter((s) => /Time is nearly up/.test(s))).toHaveLength(1);
    expect(k.counts.close).toBe(1);
    tick(60_000);
    expect(sent.filter((s) => /Time is nearly up/.test(s))).toHaveLength(1);
  });
});

describe("the first words, ready before pickup (greeting.ts)", () => {
  const chunk = (n: number) => new Int16Array([n]);

  test("held while it rings, played in order on release, then passed straight through", () => {
    const played: number[] = [];
    const g = new ReadyGreeting({ play: (p) => played.push(p[0]!) });
    g.asked();
    g.audio(chunk(1));
    g.audio(chunk(2));
    expect(played).toEqual([]);
    expect(g.isReady).toBe(true);
    expect(g.isReleased).toBe(false);
    g.release("hello");
    expect(played).toEqual([1, 2]);
    g.audio(chunk(3));
    expect(played).toEqual([1, 2, 3]);
    g.release("silence"); // once only
    expect(played).toEqual([1, 2, 3]);
  });

  test("preparing until its turn is done or the wait runs out — the opening cue holds off", () => {
    let t = 0;
    const g = new ReadyGreeting({ play: () => {}, now: () => t });
    expect(g.preparing()).toBe(false); // never asked
    g.asked();
    expect(g.preparing()).toBe(true);
    t = GREETING_WAIT_MS - 1;
    expect(g.preparing()).toBe(true);
    t = GREETING_WAIT_MS;
    expect(g.preparing()).toBe(false); // too long: the opening cue may step in
    const h = new ReadyGreeting({ play: () => {}, now: () => 0 });
    h.asked();
    h.turnDone();
    expect(h.preparing()).toBe(false);
  });

  test("played, and whether it has spoken since — the reply to the greeting is watched", () => {
    const g = new ReadyGreeting({ play: () => {}, now: () => 0 });
    g.asked();
    g.audio(chunk(1));
    expect(g.played).toBe(false);
    g.turnDone(); // the greeting's transcript arrived
    g.release("hello");
    expect(g.played).toBe(true);
    expect(g.repliedSince).toBe(false);
    g.audio(chunk(2)); // its answer to their "yes, speaking"
    expect(g.repliedSince).toBe(true);
    // Released before it was ready: streamed live, and still not a reply until its turn ends.
    const h = new ReadyGreeting({ play: () => {}, now: () => 0 });
    h.asked();
    h.release("hello");
    h.audio(chunk(1));
    expect(h.played).toBe(true);
    expect(h.repliedSince).toBe(false);
  });

  test("the cue asks for the exact words and nothing more", () => {
    expect(greetingCue("Hello, am I speaking with Meera?")).toContain(
      'exactly: "Hello, am I speaking with Meera?" — nothing more',
    );
  });
});

describe("our line decides the turns (turn-detector.ts)", () => {
  const LOUD = 2_000; // speech
  const LOUDER = 4_000; // speech clearly over the line's echo
  const QUIET = 50; // line silence
  function detector() {
    let t = 0;
    const log: string[] = [];
    let frames = 0;
    const d = new TurnDetector({
      start: () => log.push("start"),
      audio: () => frames++,
      end: () => log.push("end"),
      bargeIn: () => log.push("barge_in"),
      now: () => t,
    });
    /** `ms` of frames at `level` (20 ms each). */
    const run = (ms: number, level: number, assistant = false) => {
      for (let i = 0; i < ms; i += 20) {
        t += 20;
        d.frame(new Int16Array(160), level, assistant);
      }
    };
    return { d, log, run, frames: () => frames };
  }

  test("a short answer ends after a short silence; the start is kept (10 November)", () => {
    const { log, run, frames } = detector();
    run(500, QUIET);
    run(700, LOUD); // "Yes, speaking."
    expect(log).toEqual(["start"]);
    run(TURN_DETECT.endAfterShortMs - 40, QUIET);
    expect(log).toEqual(["start"]);
    run(60, QUIET);
    expect(log).toEqual(["start", "end"]);
    // the 200 ms before it opened went with it
    expect(frames()).toBeGreaterThanOrEqual((200 + 700) / 20);
  });

  test("a longer answer gets room for a thinking pause", () => {
    const { log, run } = detector();
    run(3_000, LOUD);
    run(TURN_DETECT.endAfterShortMs + 100, QUIET); // a pause mid-answer
    run(2_500, LOUD);
    expect(log).toEqual(["start"]);
    run(TURN_DETECT.endAfterLongMs + 40, QUIET);
    expect(log).toEqual(["start", "end"]);
  });

  test("while the assistant speaks, its own echo is dropped", () => {
    const { log, run, frames } = detector();
    run(440, LOUD, true); // the 0.44 s echo that cut a call off
    run(500, QUIET, true);
    expect(log).toEqual([]);
    expect(frames()).toBe(0);
  });

  test("a real interruption is passed on whole, and the assistant stops", () => {
    const { log, run, frames } = detector();
    run(TURN_DETECT.bargeInMs + 100, LOUDER, true);
    expect(log).toEqual(["barge_in", "start"]);
    expect(frames()).toBeGreaterThanOrEqual(TURN_DETECT.bargeInMs / 20);
    run(600, QUIET);
    expect(log).toEqual(["barge_in", "start", "end"]);
  });

  test("speech that began over its last words is a normal turn once it stops", () => {
    const { log, run } = detector();
    run(200, LOUD, true);
    run(600, LOUD, false);
    expect(log).toEqual(["start"]);
  });
});
