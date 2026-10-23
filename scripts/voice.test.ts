/**
 * Voice foundation (src/server/voice/*, aiVoiceSession framing): the G.711
 * codec, the call-audio resampler, RTP parsing, SIP parsing and digest auth,
 * SDP, and the live-session setup / usage helpers. No network.
 * Run: bun test scripts/voice.test.ts
 */
import { describe, expect, test } from "bun:test";

import { sumVoiceUsage, voiceSetupMessage } from "../src/lib/ai-gateway.server";
import { decodeG711, encodeG711, PCMA, PCMU } from "../src/server/voice/g711";
import { Resampler, bytesFromPcm, pcmFromBytes } from "../src/server/voice/resample";
import { parseRtp } from "../src/server/voice/rtp";
import {
  CallFailed,
  digestAuthorization,
  parseSdp,
  parseSipMessage,
  uriOf,
} from "../src/server/voice/sip";

describe("G.711", () => {
  test("known code points", () => {
    expect([...decodeG711(Uint8Array.from([0xff, 0x00, 0x80]), PCMU)]).toEqual([0, -32124, 32124]);
    expect([...decodeG711(Uint8Array.from([0xd5, 0x55]), PCMA)]).toEqual([8, -8]);
  });

  test.each([PCMU, PCMA] as const)("encode is the nearest decode (pt %i)", (pt) => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const decoded = decodeG711(all, pt);
    // Every code survives a round trip up to codes that decode to the same value.
    expect([...decodeG711(encodeG711(decoded, pt), pt)]).toEqual([...decoded]);
    // Any sample comes back within the codec's step size (≤ ~3% above 1000).
    const samples = Int16Array.from({ length: 2000 }, (_, i) => -32000 + i * 32);
    const back = decodeG711(encodeG711(samples, pt), pt);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      expect(Math.abs(back[i]! - s)).toBeLessThanOrEqual(Math.max(64, Math.abs(s) * 0.035));
    }
  });
});

function tone(freq: number, rate: number, n: number, amp = 10000): Int16Array {
  return Int16Array.from({ length: n }, (_, i) =>
    Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)),
  );
}
const rms = (x: Int16Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** Feed a signal through in 20 ms chunks, as a call does. */
function stream(r: Resampler, x: Int16Array, chunk: number): Int16Array {
  const parts: Int16Array[] = [];
  for (let i = 0; i < x.length; i += chunk) parts.push(r.process(x.subarray(i, i + chunk)));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("resampler", () => {
  test("8 → 16 kHz doubles the samples and keeps a 1 kHz tone's level", () => {
    const x = tone(1000, 8000, 8000);
    const y = stream(new Resampler(2, 1), x, 160);
    expect(y.length).toBe(16000);
    const settled = y.subarray(200);
    expect(rms(settled) / rms(x)).toBeGreaterThan(0.95);
    expect(rms(settled) / rms(x)).toBeLessThan(1.05);
  });

  test("24 → 8 kHz keeps speech-band audio and removes what would alias", () => {
    const pass = stream(new Resampler(1, 3), tone(1000, 24000, 24000), 480);
    expect(pass.length).toBe(8000);
    expect(rms(pass.subarray(100)) / rms(tone(1000, 24000, 24000))).toBeGreaterThan(0.95);
    // 6 kHz cannot exist at 8 kHz; it must be filtered, not folded to 2 kHz.
    const stop = stream(new Resampler(1, 3), tone(6000, 24000, 24000), 480);
    expect(rms(stop.subarray(100)) / 7071).toBeLessThan(0.03);
  });

  test("chunk size does not change the output", () => {
    const x = tone(700, 24000, 4800);
    expect([...stream(new Resampler(1, 3), x, 480)]).toEqual([
      ...stream(new Resampler(1, 3), x, 37),
    ]);
  });

  test("PCM bytes round trip (little-endian)", () => {
    const x = Int16Array.from([0, 1, -1, 32767, -32768]);
    expect([...pcmFromBytes(bytesFromPcm(x))]).toEqual([...x]);
    expect([...bytesFromPcm(Int16Array.from([0x0102]))]).toEqual([0x02, 0x01]);
  });
});

describe("RTP", () => {
  const header = (b0: number, pt: number) => [b0, pt, 0, 1, 0, 0, 0, 160, 1, 2, 3, 4];
  test("plain, CSRC, extension and padding", () => {
    expect(parseRtp(Uint8Array.from([...header(0x80, 0), 1, 2, 3]))).toMatchObject({
      pt: 0,
      payload: Uint8Array.from([1, 2, 3]),
    });
    const csrc = parseRtp(Uint8Array.from([...header(0x81, 8), 9, 9, 9, 9, 5, 6]));
    expect([...csrc!.payload]).toEqual([5, 6]);
    const ext = parseRtp(Uint8Array.from([...header(0x90, 0), 0xbe, 0xde, 0, 1, 7, 7, 7, 7, 4]));
    expect([...ext!.payload]).toEqual([4]);
    const padded = parseRtp(Uint8Array.from([...header(0xa0, 0), 1, 2, 0, 0, 3]));
    expect([...padded!.payload]).toEqual([1, 2]);
  });
  test("comfort noise, DTMF, wrong version and runts are ignored", () => {
    expect(parseRtp(Uint8Array.from([...header(0x80, 13), 1]))).toBeNull();
    expect(parseRtp(Uint8Array.from([...header(0x80, 101), 1]))).toBeNull();
    expect(parseRtp(Uint8Array.from([...header(0x40, 0), 1]))).toBeNull();
    expect(parseRtp(Uint8Array.from([0x80, 0]))).toBeNull();
  });
});

describe("SIP", () => {
  test("digest auth matches RFC 2617 §3.5", () => {
    const h = digestAuthorization(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
      "GET",
      "/dir/index.html",
      "Mufasa",
      "Circle Of Life",
      "0a4f113b",
    );
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(h).toContain("qop=auth, nc=00000001");
  });

  test("responses, compact headers and CSeq", () => {
    const m = parseSipMessage(
      "SIP/2.0 180 Ringing\r\nv: SIP/2.0/UDP a;branch=z\r\nVia: SIP/2.0/UDP b\r\ni: abc@x\r\nCSeq: 2 INVITE\r\nt: <sip:1@pbx>;tag=99\r\n\r\n",
    );
    expect(m).toMatchObject({
      isResponse: true,
      status: 180,
      reason: "Ringing",
      cseq: { num: 2, method: "INVITE" },
    });
    expect(m.all("via")).toHaveLength(2);
    expect(m.get("call-id")).toBe("abc@x");
    const req = parseSipMessage("BYE sip:3001@10.0.0.1 SIP/2.0\r\nCSeq: 7 BYE\r\n\r\n");
    expect(req).toMatchObject({
      isResponse: false,
      method: "BYE",
      cseq: { num: 7, method: "BYE" },
    });
    expect(uriOf('"PBX" <sip:9876@34.0.0.1:5060;transport=udp>;tag=1')).toBe(
      "sip:9876@34.0.0.1:5060;transport=udp",
    );
  });

  test("SDP: where to send audio and which codec", () => {
    const sdp = "v=0\r\nc=IN IP4 10.1.2.3\r\nm=audio 12000 RTP/AVP 8 0 101\r\n";
    expect(parseSdp(sdp)).toEqual({ remote: { address: "10.1.2.3", port: 12000 }, pt: 8 });
    expect(parseSdp("v=0\r\n")).toBeNull();
    expect(() => parseSdp("c=IN IP4 1.1.1.1\r\nm=audio 1 RTP/AVP 9 18\r\n")).toThrow(CallFailed);
  });
});

describe("live voice session framing", () => {
  test("setup frame: audio out, both sides transcribed, tools declared", () => {
    const m = voiceSetupMessage({
      model: "models/m",
      system: "be brief",
      voice: "Kore",
      tools: [{ name: "end_call", description: "hang up" }],
    });
    expect(m.setup.model).toBe("models/m");
    expect(m.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(m.setup.inputAudioTranscription).toEqual({});
    expect(m.setup.outputAudioTranscription).toEqual({});
    expect(m.setup.tools[0]!.functionDeclarations).toEqual([
      { name: "end_call", description: "hang up" },
    ]);
  });

  test("usage: what the provider reported, summed; null when nothing came", () => {
    expect(sumVoiceUsage([])).toBeNull();
    expect(
      sumVoiceUsage([
        { promptTokenCount: 100, responseTokenCount: 20, totalTokenCount: 120 },
        { promptTokenCount: 150, responseTokenCount: 30 },
      ]),
    ).toEqual({ promptTokens: 250, completionTokens: 50, totalTokens: 300 });
    // Vertex: candidates + thoughts are output (as reported on a real session).
    const vertex = { promptTokenCount: 143, candidatesTokenCount: 176, thoughtsTokenCount: 104 };
    expect(sumVoiceUsage([{ ...vertex, totalTokenCount: 423 }])).toEqual({
      promptTokens: 143,
      completionTokens: 280,
      totalTokens: 423,
    });
    expect(sumVoiceUsage([vertex])).toEqual({
      promptTokens: 143,
      completionTokens: 280,
      totalTokens: 423,
    });
  });
});
