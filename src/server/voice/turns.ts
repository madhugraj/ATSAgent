/**
 * Who owes the next words on an AI phone call — one turn manager for all
 * three calls (screening, scheduling, negotiation).
 *
 * Why it exists: a live voice model often treats "speak, then call a tool" as
 * the end of its turn and waits for the candidate, who is waiting for it. The
 * same silence came back call after call (after the hello, after a tool
 * result, after a signpost like "Now a few practical details."), and each fix
 * landed in one of the three session files only. This class is the one place
 * that decides the assistant owes the line and cues it — the same rules on
 * every call.
 *
 * The assistant owes the next words when:
 *  - after_tool: a tool result came back (it must speak on: the next question,
 *    the read-back the system returned, a refusal it must act on);
 *  - mid_turn: its turn ended on a statement, not a question or a goodbye;
 *  - reply: the candidate stopped speaking and it has not answered.
 * And when the candidate's answer runs past `longAnswerMs`, it is told at their
 * next pause to thank them and move on (long_answer, once per answer).
 * The line must then be quiet (nothing playing, nobody speaking) for the
 * reason's wait before a cue; a cue repeats after `repeatMs`, at most
 * `maxCues` times per silence. Any assistant audio or candidate speech clears
 * what is owed.
 *
 * It also holds the assistant to its word: when it says it has noted
 * something ("I'll note that…") and no record tool ran around then, it is told
 * to record it — a record the hiring team relies on is never left to chance.
 *
 * Pure apart from the injected clock and `send`; unit-tested.
 */
import { voiceDebug } from "./debug";

export type CueReason = "after_tool" | "mid_turn" | "reply" | "unrecorded_note" | "long_answer";
export type CueCounts = Record<CueReason, number>;

export const TURN_TIMING = {
  /** Quiet after a tool result before the first cue. */
  afterToolMs: 2_500,
  /** Quiet after a turn that ended on a statement. */
  midTurnMs: 3_500,
  /** Quiet after the candidate stopped speaking (the model waits ~1.6 s, then thinks). */
  replyMs: 7_000,
  /** Quiet after a cue before it is repeated. */
  repeatMs: 3_000,
  /** Cues per silence. */
  maxCues: 3,
  /** A record tool this close before "I've noted…" covers it. */
  notedWithinMs: 15_000,
  /** …and this long after it to make the record before it is reminded. */
  noteGraceMs: 6_000,
  /**
   * The candidate has been answering this long (from their first word since the
   * assistant last spoke): at their next pause it is told to move on. A test call
   * on 10 November let answers run on while it kept listening.
   */
  longAnswerMs: 90_000,
};

const CUE_TEXT: Record<CueReason, string> = {
  after_tool:
    "(The candidate is waiting in silence. Continue now, out loud, with your next step — the next question, or what the tool result told you to say.)",
  mid_turn:
    "(You stopped speaking and the candidate is waiting. Continue now with what you were about to say or ask.)",
  reply:
    "(There is silence on the line. If the candidate has answered, reply now; if not, ask simply whether they can hear you.)",
  unrecorded_note:
    "(You told the candidate you noted something, but nothing was recorded. Call the record tool now with what they said — in their words — then carry on.)",
  long_answer:
    '(The candidate\'s answer has run long. Record what they said, then at this pause say "Thank you — in the interest of time, let me move on." and go to your next step.)',
};

/** "I'll note that", "I have noted", "noted down", "I'll pass that on" … */
export const SAYS_NOTED =
  /\b(i'?ll|i will|i'?ve|i have|let me)\s+(make\s+a\s+)?(note|noted|record|pass (that|it|this) on)\b|\bnoted (that|down|it)\b/i;
const GOODBYE = /\b(good\s?bye|bye|take care|have a (good|great|nice|lovely) (day|evening))\b/i;

export class TurnKeeper {
  private owed: CueReason | null = null;
  private lastSound: number;
  private cues = 0;
  private started = false;
  private ended = false;
  private lastRecordAt = Number.NEGATIVE_INFINITY;
  private noteSince: number | null = null;
  /** When the candidate began answering (first word since the assistant last spoke). */
  private answerSince: number | null = null;
  private longCued = false;
  readonly counts: CueCounts = {
    after_tool: 0,
    mid_turn: 0,
    reply: 0,
    unrecorded_note: 0,
    long_answer: 0,
  };

  constructor(
    private readonly o: {
      send: (text: string) => void;
      /** Called for each cue (log it). */
      onCue?: (reason: CueReason) => void;
      /** Tools that keep a record the assistant may say it "noted". Empty: no note check. */
      recordTools?: ReadonlySet<string>;
      /** Tools that end the call: nothing is owed after them. */
      endTools: ReadonlySet<string>;
      /** Whether a tool result needs a spoken follow-up (default: every non-end tool). */
      speakAfter?: (name: string) => boolean;
      now?: () => number;
      timing?: Partial<typeof TURN_TIMING>;
    },
  ) {
    this.lastSound = this.now();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private get t() {
    return { ...TURN_TIMING, ...this.o.timing };
  }
  private owe(reason: CueReason | null): void {
    this.owed = reason;
    this.cues = 0;
  }

  /** A chunk of the assistant's audio. */
  aiAudio(): void {
    this.started = true;
    this.lastSound = this.now();
    this.owe(null);
    this.answerSince = null;
    this.longCued = false;
  }

  /** A finished line of the assistant's (the turn's transcript). */
  aiTurn(text: string): void {
    const t = this.now();
    this.started = true;
    this.lastSound = t;
    const said = text.trim();
    if (!this.ended && said) {
      // A question hands the floor to the candidate; a goodbye closes; anything
      // else (an acknowledgement, a signpost) means it should go on.
      this.owe(/\?\s*$/.test(said) || GOODBYE.test(said) ? null : "mid_turn");
    }
    if (
      this.o.recordTools?.size &&
      SAYS_NOTED.test(said) &&
      t - this.lastRecordAt > this.t.notedWithinMs
    )
      this.noteSince = t;
  }

  /** The candidate's VAD: speech started or ended. */
  caller(event: "start" | "end" | null, active: boolean): void {
    const t = this.now();
    if (active || event === "start") {
      this.lastSound = t;
      this.owe(null);
      if (this.answerSince === null && this.started) this.answerSince = t;
    }
    if (event === "end") {
      // Timed from when they stopped, not from their first word.
      this.lastSound = t;
      if (this.started && !this.ended) {
        this.owe("reply");
        // Talked past the limit: at this pause it is told to move on (once per answer).
        if (
          !this.longCued &&
          this.answerSince !== null &&
          t - this.answerSince > this.t.longAnswerMs
        ) {
          this.longCued = true;
          this.cue("long_answer");
        }
      }
    }
  }

  /** A tool ran (whether or not it went through). */
  tool(name: string, ok: boolean): void {
    const t = this.now();
    if (ok && this.o.recordTools?.has(name)) {
      this.lastRecordAt = t;
      this.noteSince = null;
    }
    if (ok && this.o.endTools.has(name)) {
      this.end();
      return;
    }
    if (!ok || (this.o.speakAfter ?? (() => true))(name)) {
      this.lastSound = t;
      this.owe("after_tool");
    }
  }

  /** The call is ending: nothing is owed any more. */
  end(): void {
    this.ended = true;
    this.owe(null);
    this.noteSince = null;
  }

  /** Every ~250 ms; `playing`: the assistant's audio is still queued on the line. */
  tick(playing: boolean): void {
    if (this.ended || !this.started) return;
    const t = this.now();
    if (playing) {
      this.lastSound = t;
      return;
    }
    if (this.noteSince !== null && t - this.noteSince > this.t.noteGraceMs) {
      this.noteSince = null;
      this.cue("unrecorded_note");
      return;
    }
    if (this.owed === null || this.cues >= this.t.maxCues) return;
    const wait =
      this.cues > 0
        ? this.t.repeatMs
        : this.owed === "after_tool"
          ? this.t.afterToolMs
          : this.owed === "mid_turn"
            ? this.t.midTurnMs
            : this.t.replyMs;
    if (t - this.lastSound < wait) return;
    this.cues++;
    this.lastSound = t;
    this.cue(this.owed);
  }

  private cue(reason: CueReason): void {
    this.counts[reason]++;
    voiceDebug({ kind: "cue", reason });
    this.o.onCue?.(reason);
    this.o.send(CUE_TEXT[reason]);
  }
}
