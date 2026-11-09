/**
 * Server-side voice activity detection on the caller's 20 ms frames.
 *
 * A single frame's RMS flickers with breaths and line noise, and a loud
 * speakerphone can carry the assistant's own voice back up the line, where the
 * model hears it as an interruption and cuts itself off mid-word. This adds
 * hysteresis in both directions: speech starts only after a run of voiced
 * frames and lingers through a short hangover of silent ones, so callers'
 * gating and interruption decisions rest on a state that does not flicker.
 */
/** Above this RMS (int16) a 20 ms frame is speech, not line noise. */
export const SPEECH_RMS = 600;
export function rms(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

/** Above this RMS (int16) a 20 ms frame is voiced. */
export const VAD_RMS = SPEECH_RMS;
/** Voiced frames this long (at 20 ms each) open a speech segment. */
export const VAD_START_FRAMES = 3; // 60 ms
/** Silent frames this long after speech close the segment (a pause is not an end). */
export const VAD_HANGOVER_FRAMES = 15; // 300 ms

export type VadEvent = "start" | "end";

export class Vad {
  private voicedRun = 0;
  private silentRun = 0;
  private active = false;
  /** Speech segments opened, for the end-of-call log. */
  segments = 0;

  /** Feed one 20 ms frame; returns "start"/"end" when the segment state flips. */
  process(pcm: Int16Array): VadEvent | null {
    const voiced = rms(pcm) > VAD_RMS;
    if (voiced) {
      this.voicedRun++;
      this.silentRun = 0;
    } else {
      this.silentRun++;
      this.voicedRun = 0;
    }
    if (!this.active && this.voicedRun >= VAD_START_FRAMES) {
      this.active = true;
      this.segments++;
      return "start";
    }
    if (this.active && this.silentRun >= VAD_HANGOVER_FRAMES) {
      this.active = false;
      return "end";
    }
    return null;
  }

  /** Inside a speech segment (speech until 300 ms after it stops). */
  isActive(): boolean {
    return this.active;
  }

  /** New call, new line. */
  reset(): void {
    this.voicedRun = 0;
    this.silentRun = 0;
    this.active = false;
  }
}
