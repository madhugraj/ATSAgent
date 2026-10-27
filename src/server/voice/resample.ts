/**
 * Streaming fixed-ratio resampler for call audio (int16 mono).
 *
 * Phone audio is 8 kHz; the live voice model takes 16 kHz and speaks at 24 kHz,
 * so each direction is converted on the way through (8→16 kHz up by 2,
 * 24→8 kHz down by 3). A polyphase windowed-sinc low-pass filter, with the
 * filter history carried between chunks so 20 ms frames join without clicks.
 */
export class Resampler {
  private readonly h: Float64Array;
  private readonly perPhase: number;
  private history: Float64Array;
  /** Index, in the upsampled stream, of the next output sample. */
  private next = 0;
  /** Input samples consumed so far. */
  private consumed = 0;

  constructor(
    private readonly up: number,
    private readonly down: number,
    taps = 48,
  ) {
    this.perPhase = Math.max(2, Math.ceil(taps / up));
    const n = this.perPhase * up;
    // Cut-off just below the lower of the two Nyquist rates, in cycles per
    // upsampled sample; gain `up` restores the level lost to zero-stuffing.
    const fc = (0.5 / Math.max(up, down)) * 0.92;
    const c = (n - 1) / 2;
    this.h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = i - c;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
      this.h[i] = up * sinc * w;
    }
    this.history = new Float64Array(this.perPhase - 1);
  }

  /** Convert one chunk; returns however many output samples it completes. */
  process(input: Int16Array): Int16Array {
    const keep = this.perPhase - 1;
    const buf = new Float64Array(keep + input.length);
    buf.set(this.history);
    for (let i = 0; i < input.length; i++) buf[keep + i] = input[i]!;
    const end = this.consumed + input.length;
    const out: number[] = [];
    for (;;) {
      const i = Math.floor(this.next / this.up);
      if (i >= end) break;
      const phase = this.next % this.up;
      const at = i - this.consumed + keep;
      let acc = 0;
      for (let j = 0; j < this.perPhase; j++) acc += this.h[phase + j * this.up]! * buf[at - j]!;
      out.push(acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc));
      this.next += this.down;
    }
    this.consumed = end;
    this.history = buf.slice(buf.length - keep);
    return Int16Array.from(out);
  }
}

/** Little-endian PCM bytes ↔ int16 samples (call audio and the model use raw PCM16). */
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function bytesFromPcm(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}
