/**
 * Line echo removal (src/server/voice/echo.ts), on simulated calls:
 *  - the assistant's own voice coming back (300 ms later, at 60% — and a loud
 *    100% echo like the 16 November call) is removed once the delay is found;
 *  - the candidate talking over the assistant is kept;
 *  - the candidate speaking while the assistant is silent is never touched;
 *  - a line with no echo removes nothing.
 * Run: bun test scripts/voice-echo.test.ts
 */
import { describe, expect, test } from "bun:test";

const { EchoRemover } = await import("../src/server/voice/echo");

/** A 20 ms frame of a tone at amplitude `a` (RMS ≈ a / √2). */
function frame(a: number, phase = 0): Int16Array {
  const f = new Int16Array(160);
  for (let i = 0; i < 160; i++)
    f[i] = Math.round(a * Math.sin((2 * Math.PI * 300 * i) / 8000 + phase));
  return f;
}
const level = (f: Int16Array) => Math.sqrt(f.reduce((s, x) => s + x * x, 0) / f.length);

/** Speech-like loudness: syllables of 100–300 ms with short pauses (seeded). */
function speech(frames: number, peak: number, seed = 1): number[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out: number[] = [];
  while (out.length < frames) {
    const on = 5 + Math.floor(rnd() * 10);
    const off = 1 + Math.floor(rnd() * 4);
    const a = peak * (0.5 + rnd() * 0.5);
    for (let i = 0; i < on; i++) out.push(a);
    for (let i = 0; i < off; i++) out.push(0);
  }
  return out.slice(0, frames);
}

/**
 * Run a call: `assistant` is what we send per frame; the line returns it
 * `delay` frames later at `ratio`, plus `candidate` speech. Returns which
 * incoming frames were kept.
 */
function run(o: {
  assistant: number[];
  candidate: number[];
  delay: number;
  ratio: number;
  /** The line's hiss (amplitude). */
  noise?: number;
}) {
  const e = new EchoRemover();
  const kept: boolean[] = [];
  for (let t = 0; t < o.assistant.length; t++) {
    e.sent(frame(o.assistant[t]!));
    const echo = t >= o.delay ? o.assistant[t - o.delay]! * o.ratio : 0;
    const near = frame(echo, 0.7);
    const cand = o.candidate[t] ?? 0;
    // The candidate's voice and the echo add (different phase).
    const mixed = new Int16Array(160);
    const c = frame(cand, 1.9);
    for (let i = 0; i < 160; i++) {
      const hiss = o.noise ? Math.round((Math.random() * 2 - 1) * o.noise) : 0;
      mixed[i] = Math.max(-32768, Math.min(32767, near[i]! + c[i]! + hiss));
    }
    kept.push(level(e.received(mixed)) > 0);
  }
  return { kept, stats: e.stats() };
}

const share = (xs: boolean[]) => xs.filter(Boolean).length / Math.max(1, xs.length);

describe("the line's echo of the assistant", () => {
  test("found and removed: 300 ms delay, 60% returned", () => {
    const assistant = speech(500, 6000); // 10 s of the assistant talking
    const { kept, stats } = run({ assistant, candidate: [], delay: 15, ratio: 0.6 });
    expect(stats.delayMs).toBe(300);
    // After the first 2 s (finding the delay), echo frames are removed.
    const echoFrames = kept.slice(100).filter((_, i) => assistant[100 + i - 15]! > 300);
    expect(share(echoFrames)).toBeLessThan(0.1);
  });

  test("a loud echo, as loud as what we sent (16 November), is removed too", () => {
    const assistant = speech(500, 6000, 7);
    const { kept, stats } = run({ assistant, candidate: [], delay: 22, ratio: 1.0 });
    expect(stats.delayMs).toBe(440);
    const echoFrames = kept.slice(100).filter((_, i) => assistant[100 + i - 22]! > 300);
    expect(share(echoFrames)).toBeLessThan(0.1);
  });

  test("on a line with hiss, the echo is still found and removed", () => {
    const assistant = speech(500, 6000, 11);
    const { kept, stats } = run({ assistant, candidate: [], delay: 15, ratio: 0.6, noise: 400 });
    expect(stats.delayMs).toBe(300);
    const echoFrames = kept.slice(100).filter((_, i) => assistant[100 + i - 15]! > 300);
    expect(share(echoFrames)).toBeLessThan(0.15);
  });

  test("the candidate talking over the assistant is kept", () => {
    const assistant = speech(500, 6000, 3);
    const candidate = new Array(500).fill(0);
    for (let t = 300; t < 360; t++) candidate[t] = 12_000; // a clear "Sorry, can I ask…"
    const { kept } = run({ assistant, candidate, delay: 15, ratio: 0.6 });
    expect(share(kept.slice(300, 360))).toBeGreaterThan(0.9);
  });

  test("the candidate speaking while the assistant is silent is never touched", () => {
    const assistant = [...speech(250, 6000, 5), ...new Array(250).fill(0)];
    const candidate = new Array(500).fill(0);
    for (let t = 300; t < 450; t++) candidate[t] = 3_000; // a normal-volume answer
    const { kept } = run({ assistant, candidate, delay: 15, ratio: 0.6 });
    expect(share(kept.slice(300, 450))).toBe(1);
  });

  test("a line with no echo removes nothing", () => {
    const assistant = speech(500, 6000, 9);
    const candidate = new Array(500).fill(0);
    for (let t = 200; t < 260; t++) candidate[t] = 3_000;
    const { kept, stats } = run({ assistant, candidate, delay: 15, ratio: 0 });
    expect(stats.removedFrames).toBe(0);
    expect(share(kept.slice(200, 260))).toBe(1);
  });
});

describe("across many lines", () => {
  test("echo removed and the candidate kept, for 10 speech patterns, 100–800 ms, 30–100%", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const delay = 5 + ((seed * 7) % 36); // 100–800 ms
      const ratio = 0.3 + ((seed * 13) % 8) / 10; // 0.3–1.0
      const noise = seed % 2 ? 0 : 300;
      const assistant = speech(600, 6000, seed);
      const candidate = new Array(600).fill(0);
      for (let t = 450; t < 520; t++) candidate[t] = 14_000; // talks over it
      const { kept, stats } = run({ assistant, candidate, delay, ratio, noise });
      expect(stats.delayMs).toBe(delay * 20);
      const echoOnly = kept.slice(120, 440).filter((_, i) => assistant[120 + i - delay]! > 300);
      expect(share(echoOnly)).toBeLessThan(0.15);
      expect(share(kept.slice(450, 520))).toBeGreaterThan(0.85);
    }
  });

  test("no echo on the line: a candidate's answers are never removed, for 10 patterns", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const assistant = speech(600, 6000, seed);
      const candidate = speech(600, 3000, seed + 100); // talks a lot, any time
      const { kept } = run({
        assistant,
        candidate,
        delay: 15,
        ratio: 0,
        noise: seed % 2 ? 0 : 300,
      });
      const theirs = kept.filter((_, t) => candidate[t]! > 0);
      expect(share(theirs)).toBe(1);
    }
  });
});

describe("echo and a talkative candidate together", () => {
  test("the delay still locks on, the echo goes, their words stay", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const assistant = speech(800, 6000, seed);
      const candidate = new Array(800).fill(0);
      // They chip in now and then ("yes", "okay", a longer reply) — loud over the echo.
      for (const [from, len] of [
        [150, 20],
        [300, 40],
        [520, 60],
        [700, 30],
      ] as const)
        for (let t = from; t < from + len; t++) candidate[t] = 12_000;
      const delay = 10 + seed * 3;
      const { kept, stats } = run({ assistant, candidate, delay, ratio: 0.7, noise: 200 });
      expect(stats.delayMs).toBe(delay * 20);
      const echoOnly = kept
        .slice(200)
        .filter((_, i) => candidate[200 + i] === 0 && assistant[200 + i - delay]! > 300);
      expect(share(echoOnly)).toBeLessThan(0.2);
      const theirs = kept.filter((_, t) => candidate[t]! > 0);
      expect(share(theirs)).toBeGreaterThan(0.85);
    }
  });
});
