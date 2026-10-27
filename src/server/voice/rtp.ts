/**
 * RTP media for one call: sends a 20 ms G.711 packet every 20 ms (silence when
 * there is nothing to say) and hands received audio over as 8 kHz int16 PCM.
 * Port of RtpStream in ai_interviewer/sip.py.
 */
import { randomInt } from "node:crypto";
import dgram from "node:dgram";

import { decodeG711, encodeG711, PCMA, PCMU, type G711 } from "./g711";

export const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const FRAME_MS = 20;

export type Endpoint = { address: string; port: number };

/** Parse one RTP packet; null for anything that is not G.711 audio (CN, DTMF, junk). */
export function parseRtp(data: Uint8Array): { pt: G711; payload: Uint8Array } | null {
  if (data.length < 12 || data[0]! >> 6 !== 2) return null;
  const pt = data[1]! & 0x7f;
  if (pt !== PCMU && pt !== PCMA) return null;
  let offset = 12 + 4 * (data[0]! & 0x0f);
  if (data[0]! & 0x10) {
    if (data.length < offset + 4) return null;
    offset += 4 + 4 * ((data[offset + 2]! << 8) | data[offset + 3]!);
  }
  let end = data.length;
  if (data[0]! & 0x20 && end > offset) end -= data[end - 1]!;
  if (end <= offset) return null;
  return { pt, payload: data.subarray(offset, end) };
}

export class RtpStream {
  private readonly sock = dgram.createSocket("udp4");
  private out = new Int16Array(8000 * 4);
  private outLen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latched = false;
  private seq = randomInt(0, 0x10000);
  private ts = randomInt(0, 0xffffffff);
  private readonly ssrc = randomInt(0, 0xffffffff);
  remote: Endpoint | null = null;
  pt: G711 = PCMU;
  port = 0;
  onAudio: (pcm8k: Int16Array) => void = () => {};

  /**
   * @param trusted addresses media may come from (the PBX and the address its
   *   SDP named); symmetric-RTP latching only follows one of these.
   */
  constructor(private trusted: Set<string> = new Set()) {}

  async bind(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.sock.once("error", reject);
      this.sock.bind(0, () => resolve());
    });
    this.port = this.sock.address().port;
    return this.port;
  }

  trust(address: string) {
    this.trusted.add(address);
  }

  start(remote: Endpoint, pt: G711) {
    this.remote = remote;
    this.pt = pt;
    this.trust(remote.address);
    this.sock.on("message", (msg, rinfo) => this.receive(msg, rinfo));
    let nextAt = performance.now();
    const tick = () => {
      this.sendFrame();
      nextAt += FRAME_MS;
      const now = performance.now();
      if (now - nextAt > 200) nextAt = now; // stalled; don't burst to catch up
      this.timer = setTimeout(tick, Math.max(0, nextAt - now));
    };
    tick();
  }

  /** Queue 8 kHz audio to play. */
  play(pcm8k: Int16Array) {
    if (this.outLen + pcm8k.length > this.out.length) {
      const grown = new Int16Array(Math.max(this.out.length * 2, this.outLen + pcm8k.length));
      grown.set(this.out.subarray(0, this.outLen));
      this.out = grown;
    }
    this.out.set(pcm8k, this.outLen);
    this.outLen += pcm8k.length;
  }

  /** Drop anything still queued (the caller talked over the AI). */
  clear() {
    this.outLen = 0;
  }

  pendingSeconds(): number {
    return this.outLen / 8000;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.sock.close();
    } catch {
      // already closed
    }
  }

  private sendFrame() {
    if (!this.remote) return;
    const frame = new Int16Array(FRAME_SAMPLES);
    const n = Math.min(FRAME_SAMPLES, this.outLen);
    frame.set(this.out.subarray(0, n));
    this.out.copyWithin(0, n, this.outLen);
    this.outLen -= n;
    const packet = new Uint8Array(12 + FRAME_SAMPLES);
    const view = new DataView(packet.buffer);
    packet[0] = 0x80;
    packet[1] = this.pt;
    view.setUint16(2, this.seq);
    view.setUint32(4, this.ts);
    view.setUint32(8, this.ssrc);
    packet.set(encodeG711(frame, this.pt), 12);
    this.sock.send(packet, this.remote.port, this.remote.address);
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
  }

  private receive(msg: Buffer, rinfo: dgram.RemoteInfo) {
    if (!this.trusted.has(rinfo.address)) return;
    const rtp = parseRtp(msg);
    if (!rtp) return;
    // Symmetric RTP: reply to wherever the audio actually comes from, which is
    // what gets it through NAT.
    if (!this.latched) {
      this.remote = { address: rinfo.address, port: rinfo.port };
      this.latched = true;
    }
    this.onAudio(decodeG711(rtp.payload, rtp.pt));
  }
}
