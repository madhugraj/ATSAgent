/**
 * Turn-taking stats of one answered call, measured on the line (pure; unit-
 * tested). Fed by the three call sessions (screening, scheduling,
 * negotiation) at the same points — the caller's VAD, the assistant's audio,
 * a barge-in — and stored on the call (screening_calls.call_stats) so the
 * Voice Guard can review how the call went, not only what was said: who
 * spoke first, slow replies, talking over the candidate, audio breaking up.
 * Holds no words, so it is kept whether or not the candidate consented.
 */
import type { CallStats } from "@db/schema";

import type { AudioStats } from "./rtp";
import type { VadEvent } from "./vad";

/** A reply slower than this is counted as slow. */
export const SLOW_REPLY_MS = 3_000;
/** Assistant audio after this much quiet is a new utterance. */
const UTTERANCE_GAP_MS = 400;

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

export class CallStatsTracker {
  private answeredAt: number | null = null;
  private firstCaller: number | null = null;
  private firstAi: number | null = null;
  private callerActive = false;
  private callerEndAt: number | null = null;
  private lastAiAudio: number | null = null;
  private callerSegments = 0;
  private aiUtterances = 0;
  private talkOver = 0;
  private bargeIns = 0;
  private replies: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** The candidate picked up. */
  answered(): void {
    this.answeredAt = this.now();
  }

  /** After each caller frame through the VAD. */
  caller(event: VadEvent | null): void {
    const t = this.now();
    if (event === "start") {
      this.callerActive = true;
      this.callerSegments++;
      if (this.firstCaller === null) this.firstCaller = t;
    } else if (event === "end") {
      this.callerActive = false;
      this.callerEndAt = t;
    }
  }

  /** Each chunk of the assistant's audio. */
  aiAudio(): void {
    const t = this.now();
    const fresh = this.lastAiAudio === null || t - this.lastAiAudio > UTTERANCE_GAP_MS;
    this.lastAiAudio = t;
    if (!fresh) return;
    this.aiUtterances++;
    if (this.firstAi === null) this.firstAi = t;
    if (this.callerActive) this.talkOver++;
    // A reply: the first audio after the candidate stopped talking.
    else if (this.callerEndAt !== null) {
      this.replies.push(t - this.callerEndAt);
      this.callerEndAt = null;
    }
  }

  /** The candidate spoke over the assistant and it stopped. */
  bargeIn(): void {
    this.bargeIns++;
  }

  finish(o: { languageCode: string; audio: AudioStats | null }): CallStats {
    const base = this.answeredAt;
    const since = (t: number | null) => (t === null || base === null ? null : t - base);
    const sorted = [...this.replies].sort((a, b) => a - b);
    return {
      v: 1,
      languageCode: o.languageCode,
      firstCallerMs: since(this.firstCaller),
      firstAiMs: since(this.firstAi),
      aiSpokeFirst:
        this.firstAi !== null && (this.firstCaller === null || this.firstAi < this.firstCaller),
      callerSegments: this.callerSegments,
      aiUtterances: this.aiUtterances,
      talkOver: this.talkOver,
      bargeIns: this.bargeIns,
      replyMs: {
        count: sorted.length,
        p50: pct(sorted, 0.5),
        p90: pct(sorted, 0.9),
        max: sorted.length ? sorted[sorted.length - 1]! : null,
      },
      slowReplies: sorted.filter((ms) => ms > SLOW_REPLY_MS).length,
      audio: o.audio,
    };
  }
}
