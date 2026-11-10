/**
 * Who has the turn, decided on our line — all three AI phone calls.
 *
 * Why: the voice model's own speech detection waited 1.6 s of silence before
 * replying, missed short answers ("Okay", "Yes" — a test call sat silent until a
 * cue 7 s later), and took the assistant's own voice echoing back for the
 * candidate cutting in. Our line's detector heard every utterance. So the
 * provider's detection is off (manual turns) and this class marks each of the
 * candidate's utterances with start / end: the model replies the moment it gets
 * the end — about 0.9 s later on the real service, against 1.8–2.4 s before.
 *
 * - An utterance starts after 60 ms of speech, with the 200 ms before it kept.
 * - It ends after a silence that grows with how long they have been talking: a
 *   short answer ("Yes, speaking", "Ninety days") is ended quickly; a longer one
 *   gets room for a thinking pause.
 * - While the assistant's voice is playing, only sustained, clearly louder speech
 *   counts — that is the candidate cutting in, not the line echoing the assistant
 *   back. It is then passed on whole (the held start included) and the assistant
 *   stops.
 *
 * Pure apart from the injected clock and callbacks; unit-tested.
 */
import { voiceDebug } from "./debug";
import { SPEECH_RMS } from "./vad";

const FRAME_MS = 20;
/** The assistant counts as speaking this long after its audio ran out (the line echoes). */
export const ECHO_TAIL_MS = 300;

export const TURN_DETECT = {
  /** Voiced this long opens an utterance. */
  startMs: 60,
  /** Audio kept from just before it opened. */
  preRollMs: 200,
  /** Silence that ends an utterance, by how long they have spoken so far. */
  endAfterShortMs: 600,
  endAfterMediumMs: 900,
  endAfterLongMs: 1_300,
  /** Spoke less than this: short. Less than `longFromMs`: medium. */
  shortUnderMs: 1_500,
  longFromMs: 5_000,
  /** While the assistant speaks: this much loud speech is a real interruption… */
  bargeInMs: 600,
  /** …at this many times the speech level (echo of its own voice is quieter). */
  bargeInLoudness: 2,
  /** …and a held start with this much silence after it was only echo or noise. */
  bargeInGiveUpMs: 400,
};

type State = "idle" | "speaking" | "maybe_interrupting";

export class TurnDetector {
  private state: State = "idle";
  private preRoll: Int16Array[] = [];
  private held: Int16Array[] = [];
  private voicedRun = 0;
  private loudMs = 0;
  private startedAt = 0;
  private lastVoicedAt = 0;
  private heldSince = 0;

  constructor(
    private readonly o: {
      /** The candidate started speaking (activityStart). */
      start: () => void;
      /** Their audio, inside an utterance. */
      audio: (pcm: Int16Array) => void;
      /** They finished (activityEnd): the model replies now. */
      end: () => void;
      /** They cut in on the assistant: stop its audio. */
      bargeIn: () => void;
      now?: () => number;
      timing?: Partial<typeof TURN_DETECT>;
    },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private get t() {
    return { ...TURN_DETECT, ...this.o.timing };
  }

  /** Inside an utterance of theirs now. */
  get speaking(): boolean {
    return this.state === "speaking";
  }

  /**
   * One 20 ms frame of the candidate's line. `level`: its RMS; `assistantSpeaking`:
   * the assistant's audio is playing (or only just stopped).
   */
  frame(pcm: Int16Array, level: number, assistantSpeaking: boolean): void {
    const t = this.now();
    const voiced = level > SPEECH_RMS;
    this.voicedRun = voiced ? this.voicedRun + 1 : 0;
    if (voiced) this.lastVoicedAt = t;

    if (this.state === "idle") {
      this.preRoll.push(pcm);
      if (this.preRoll.length > Math.ceil(this.t.preRollMs / FRAME_MS)) this.preRoll.shift();
      if (this.voicedRun * FRAME_MS < this.t.startMs) return;
      if (!assistantSpeaking) return this.open(t, this.preRoll);
      // The assistant is speaking: hold it until it is clearly them.
      this.state = "maybe_interrupting";
      this.held = [...this.preRoll];
      this.loudMs = 0;
      this.heldSince = t;
      this.preRoll = [];
      return;
    }

    if (this.state === "maybe_interrupting") {
      this.held.push(pcm);
      if (level > SPEECH_RMS * this.t.bargeInLoudness) this.loudMs += FRAME_MS;
      if (!assistantSpeaking) {
        // It stopped first: their words are a normal turn.
        if (voiced || t - this.lastVoicedAt < this.t.endAfterShortMs)
          return this.open(this.heldSince, this.held);
        return this.drop();
      }
      if (this.loudMs >= this.t.bargeInMs) {
        voiceDebug({ kind: "barge_in" });
        this.o.bargeIn();
        return this.open(this.heldSince, this.held);
      }
      if (t - this.lastVoicedAt >= this.t.bargeInGiveUpMs) this.drop();
      return;
    }

    // Speaking.
    this.o.audio(pcm);
    const spoken = this.lastVoicedAt - this.startedAt;
    const endAfter =
      spoken < this.t.shortUnderMs
        ? this.t.endAfterShortMs
        : spoken < this.t.longFromMs
          ? this.t.endAfterMediumMs
          : this.t.endAfterLongMs;
    if (t - this.lastVoicedAt >= endAfter) {
      this.state = "idle";
      this.voicedRun = 0;
      voiceDebug({ kind: "turn_end", spokenMs: spoken });
      this.o.end();
    }
  }

  private open(at: number, frames: Int16Array[]): void {
    this.state = "speaking";
    this.startedAt = at;
    this.o.start();
    for (const f of frames) this.o.audio(f);
    this.preRoll = [];
    this.held = [];
  }

  private drop(): void {
    voiceDebug({ kind: "echo_dropped", heldMs: this.held.length * FRAME_MS });
    this.state = "idle";
    this.held = [];
    this.voicedRun = 0;
  }
}
