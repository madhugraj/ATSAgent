/**
 * The assistant's first words, ready before the candidate picks up — all three
 * AI phone calls (screening, scheduling, negotiation).
 *
 * Why: the voice model's first reply after the candidate's "hello" sometimes
 * took 9 s or more, and a second cue then restarted it. Test calls on
 * 10 November first spoke at 13.9 s and 12.0 s after pickup, and the candidate
 * hung up on both. The first words are fixed ("Hello, am I speaking with …?"),
 * so they are asked for while the phone rings, held, and played the moment the
 * candidate's hello ends — or after a few seconds if they say nothing.
 *
 * The candidate's hello itself is not passed to the model: in its context the
 * greeting comes first and their answer to it next, so it does not greet them
 * twice. Pure apart from the injected `play` and clock; unit-tested.
 */
import { voiceDebug } from "./debug";

/** Waiting this long for the held greeting before the opening cue may step in. */
export const GREETING_WAIT_MS = 8_000;

/** What the assistant is told while the phone rings. */
export function greetingCue(words: string): string {
  return `(The phone is ringing. Say your first words now, exactly: "${words}" — nothing more. They will hear them as soon as they pick up; then wait for their answer.)`;
}

export class ReadyGreeting {
  private held: Int16Array[] = [];
  private released = false;
  private askedAt: number | null = null;
  private done = false;
  private playedAny = false;
  private spokeSince = false;

  constructor(
    private readonly o: {
      /** Plays one chunk of the assistant's audio on the line (and counts it as spoken). */
      play: (pcm: Int16Array) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The greeting was asked for (the cue is sent while the phone rings). */
  asked(): void {
    this.askedAt = this.now();
    voiceDebug({ kind: "greeting_asked" });
  }

  /** The assistant's audio: held until the greeting is released, then played. */
  audio(pcm: Int16Array): void {
    // Audio after the greeting's turn finished is the assistant's next words.
    if (this.done) this.spokeSince = true;
    if (this.released) {
      this.playedAny = true;
      this.o.play(pcm);
      return;
    }
    if (!this.held.length) voiceDebug({ kind: "greeting_ready" });
    this.held.push(pcm);
  }

  /** The assistant finished a turn (its transcript arrived). */
  turnDone(): void {
    this.done = true;
  }

  /** Released: the line is the assistant's to speak on, and the candidate's audio goes to the model. */
  get isReleased(): boolean {
    return this.released;
  }

  /** Audio is held, ready to play. */
  get isReady(): boolean {
    return this.held.length > 0;
  }

  /**
   * Still being prepared: asked for, no turn finished yet, not too long ago. The
   * opening cue must not step in meanwhile — a cue restarts the reply.
   */
  preparing(): boolean {
    return this.askedAt !== null && !this.done && this.now() - this.askedAt < GREETING_WAIT_MS;
  }

  /** The greeting was heard on the line (held audio played, or streamed after release). */
  get played(): boolean {
    return this.playedAny;
  }

  /**
   * The assistant has spoken again since its greeting — it answered their reply.
   * Until then the opening cue still watches: a test call on 10 November played the
   * greeting at once, then waited 10 s to answer "yes, speaking".
   */
  get repliedSince(): boolean {
    return this.spokeSince;
  }

  /** Play what is held, and pass everything after it straight through. */
  release(why: "hello" | "silence"): void {
    if (this.released) return;
    this.released = true;
    const held = this.held;
    this.held = [];
    voiceDebug({ kind: "greeting_played", why, chunks: held.length });
    if (held.length) this.playedAny = true;
    for (const pcm of held) this.o.play(pcm);
  }
}
