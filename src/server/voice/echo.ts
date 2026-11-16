/**
 * Line echo removal for the AI phone calls (16 November).
 *
 * Why: on some phones the assistant's own voice comes back up the line loud
 * and sustained — as loud as a person talking over it. A rule on loudness and
 * timing alone cannot tell that from a real interruption: a call lost half its
 * time to the assistant being "interrupted" by its own words, which were then
 * transcribed as the candidate saying them.
 *
 * How: we know exactly what we sent and when. Per 20 ms frame this keeps the
 * level of what went out (far end) and what came back (near end), and
 *  1. finds the line's echo delay — the lag (0–1 s) at which the level pattern
 *     coming back best matches what was sent;
 *  2. learns how much of our voice the line returns at that lag (a low
 *     percentile of near / far, so the candidate talking over us does not
 *     inflate it);
 *  3. silences an incoming frame that is no louder than the echo expected of
 *     what we sent that long ago. Someone talking over the assistant is clearly
 *     louder than its echo and passes; with no recent outgoing speech, nothing
 *     is touched.
 * An echo suppressor on frame levels, not a sample-level canceller: the phone
 * network's codecs make the echo non-linear, which defeats a linear filter,
 * while its level pattern still follows ours closely.
 *
 * Pure apart from the frame clock the caller passes in; unit-tested.
 */
import { rms } from "./vad";

export const ECHO = {
  /** Frames of history kept (20 ms each): 3 s. */
  historyFrames: 150,
  /** Longest echo delay looked for, in frames (1 s). */
  maxDelayFrames: 50,
  /** Frames compared when estimating the delay (1.5 s). */
  windowFrames: 75,
  /** Re-estimate the delay this often (frames). */
  estimateEveryFrames: 10,
  /** Below this outgoing level a frame is silence (int16 RMS). */
  farActiveRms: 300,
  /** Outgoing frames with speech needed in the window before estimating. */
  minActiveFrames: 20,
  /** Correlation (of the level changes) needed to trust a delay. */
  minCorrelation: 0.6,
  /** The same delay (±1 frame) found this many checks in a row before it is used. */
  confirmEstimates: 3,
  /** Incoming frames up to this many times the expected echo are echo. */
  echoMargin: 2.5,
  /** Return ratio percentile (robust to the candidate talking over us). */
  gainPercentile: 0.3,
  /**
   * A real echo is heard behind nearly every frame we speak; a candidate who
   * happens to talk at the same time is behind only some of them.
   */
  minEchoCoverage: 0.8,
  /** …and goes quiet when we pause: this share of our pauses must be quiet too. */
  minPauseQuiet: 0.6,
  /** Pauses needed in the window to judge that. */
  minPauseFrames: 5,
  /** Less than this share of our voice coming back is no echo worth removing. */
  minReturn: 0.05,
  /** Incoming frames quieter than this are line silence — left alone, not counted. */
  silenceRms: 150,
};

export type EchoStats = {
  /** The line's echo delay (ms), once found. */
  delayMs: number | null;
  /** How much of our voice comes back (0–1+). */
  returnRatio: number | null;
  /** Incoming frames silenced as echo. */
  removedFrames: number;
};

export class EchoRemover {
  private far: Float32Array;
  private near: Float32Array;
  /** Frame index of the latest outgoing frame. */
  private tFar = -1;
  private delay: number | null = null;
  private gain: number | null = null;
  private sinceEstimate = 0;
  private removed = 0;
  private candidateLag: number | null = null;
  private candidateHits = 0;
  /** Below this an incoming frame is the line's hiss (set with the delay). */
  private quiet = ECHO.silenceRms;
  private readonly c: typeof ECHO;

  constructor(opts: Partial<typeof ECHO> = {}) {
    this.c = { ...ECHO, ...opts };
    this.far = new Float32Array(this.c.historyFrames);
    this.near = new Float32Array(this.c.historyFrames);
  }

  private slot(t: number): number {
    return ((t % this.c.historyFrames) + this.c.historyFrames) % this.c.historyFrames;
  }

  /** One 20 ms frame went out (silence included). */
  sent(pcm: Int16Array): void {
    this.tFar++;
    this.far[this.slot(this.tFar)] = rms(pcm);
    if (this.trace.far.length < 30_000) {
      this.trace.far.push(Math.round(this.far[this.slot(this.tFar)]!));
      this.trace.near.push(0);
    }
    // The near slot for this tick starts empty until a frame arrives.
    this.near[this.slot(this.tFar)] = 0;
  }

  /**
   * One 20 ms frame came in: returns it, or silence when it is our own echo.
   * Frames are placed on the send clock (the latest outgoing frame).
   */
  received(pcm: Int16Array): Int16Array {
    if (this.tFar < 0) return pcm;
    const t = this.tFar;
    const level = rms(pcm);
    this.near[this.slot(t)] = level;
    if (t < this.trace.near.length) this.trace.near[t] = Math.round(level);
    if (++this.sinceEstimate >= this.c.estimateEveryFrames) {
      this.sinceEstimate = 0;
      this.estimate(t);
    }
    if (this.delay === null || this.gain === null) return pcm;
    // What we sent `delay` ago (±1 frame of network jitter).
    let ref = 0;
    for (let k = -1; k <= 1; k++) {
      const at = t - this.delay + k;
      if (at < 0 || t - at >= this.c.historyFrames) continue;
      ref = Math.max(ref, this.far[this.slot(at)]!);
    }
    if (ref < this.c.farActiveRms || level < this.quiet) return pcm;
    if (level <= this.gain * ref * this.c.echoMargin) {
      this.removed++;
      return new Int16Array(pcm.length);
    }
    return pcm;
  }

  /** Level history for diagnosis (local only, VOICE_ECHO_TRACE): numbers, no audio. */
  readonly trace: { far: number[]; near: number[]; estimates: unknown[] } = {
    far: [],
    near: [],
    estimates: [],
  };

  stats(): EchoStats {
    return {
      delayMs: this.delay === null ? null : this.delay * 20,
      returnRatio: this.gain === null ? null : Math.round(this.gain * 100) / 100,
      removedFrames: this.removed,
    };
  }

  /** Best lag of the incoming level pattern against the outgoing one. */
  private estimate(t: number): void {
    const { windowFrames: W, maxDelayFrames: D } = this.c;
    if (t < W + 1) return;
    let active = 0;
    for (let i = 0; i < W + D && i <= t; i++)
      if (this.far[this.slot(t - i)]! >= this.c.farActiveRms) active++;
    if (active < this.c.minActiveFrames) return;
    let best = -1;
    let bestLag = 0;
    for (let lag = 0; lag <= D; lag++) {
      if (t - lag - W + 1 < 0 || lag + W > this.c.historyFrames) break;
      // Pearson on the levels: the ups and downs must match, not just "both on".
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < W; i++) {
        sx += this.far[this.slot(t - i - lag)]!;
        sy += this.near[this.slot(t - i)]!;
      }
      const mx = sx / W;
      const my = sy / W;
      let xy = 0;
      let xx = 0;
      let yy = 0;
      for (let i = 0; i < W; i++) {
        const y = this.near[this.slot(t - i)]! - my;
        const x = this.far[this.slot(t - i - lag)]! - mx;
        xy += x * y;
        xx += x * x;
        yy += y * y;
      }
      const r = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    const note = (why: string, extra: object = {}) =>
      this.trace.estimates.length < 2_000 &&
      this.trace.estimates.push({
        t,
        lag: bestLag,
        r: Math.round(best * 100) / 100,
        why,
        ...extra,
      });
    if (best < this.c.minCorrelation) return void note("low_correlation");
    // How much comes back at that lag: a low percentile over frames we spoke in.
    // "Quiet" is relative to the line's own hiss: its floor is a low percentile
    // of everything heard lately.
    const heardLevels = Array.from(this.near).sort((a, b) => a - b);
    const floor = heardLevels[Math.floor(heardLevels.length * 0.1)] ?? 0;
    const quiet = Math.max(this.c.silenceRms, floor * 2);
    this.quiet = quiet;
    const ratios: number[] = [];
    let heard = 0;
    let pauses = 0;
    let quietPauses = 0;
    for (let i = 0; i < W; i++) {
      const x = this.far[this.slot(t - i - bestLag)]!;
      const y = this.near[this.slot(t - i)]!;
      if (x < this.c.farActiveRms) {
        pauses++;
        if (y < quiet) quietPauses++;
        continue;
      }
      ratios.push(y / x);
      if (y >= quiet) heard++;
    }
    const seen = {
      coverage: Math.round((heard / Math.max(1, ratios.length)) * 100) / 100,
      pauseQuiet: Math.round((quietPauses / Math.max(1, pauses)) * 100) / 100,
      pauses,
      quiet: Math.round(quiet),
    };
    if (ratios.length < this.c.minActiveFrames / 2) return void note("few_active", seen);
    if (heard / ratios.length < this.c.minEchoCoverage) return void note("low_coverage", seen);
    if (pauses >= this.c.minPauseFrames && quietPauses / pauses < this.c.minPauseQuiet)
      return void note("pauses_not_quiet", seen);
    ratios.sort((a, b) => a - b);
    const g = ratios[Math.floor(ratios.length * this.c.gainPercentile)]!;
    if (g < this.c.minReturn) return void note("low_return", { ...seen, g });
    // A real echo keeps its delay; a chance match moves as the talk moves on.
    if (this.candidateLag !== null && Math.abs(this.candidateLag - bestLag) <= 1)
      this.candidateHits++;
    else {
      this.candidateLag = bestLag;
      this.candidateHits = 1;
    }
    note("candidate", { ...seen, g, hits: this.candidateHits });
    if (this.candidateHits < this.c.confirmEstimates) return;
    this.delay = bestLag;
    this.gain = this.gain === null ? g : 0.7 * this.gain + 0.3 * g;
  }
}
