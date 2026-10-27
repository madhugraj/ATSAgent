/**
 * G.711 (μ-law / A-law), the audio format phone calls use.
 *
 * Lookup tables, as in the Python POC (ai_interviewer/g711.py): the encoder is
 * built from the decoder — each 16-bit sample maps to the code whose decoded
 * value is nearest — so the two can never disagree.
 */

export const PCMU = 0; // RTP payload type for μ-law
export const PCMA = 8; // RTP payload type for A-law
export type G711 = typeof PCMU | typeof PCMA;

function ulawDecodeTable(): Int16Array {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exp = (u >> 4) & 7;
    const s = (((u & 0x0f) << 3) + 0x84) * (1 << exp) - 0x84;
    t[i] = u & 0x80 ? -s : s;
  }
  return t;
}

function alawDecodeTable(): Int16Array {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55;
    const exp = (a >> 4) & 7;
    const man = a & 0x0f;
    const s = exp === 0 ? (man << 4) + 8 : ((man << 4) + 0x108) << (exp - 1);
    t[i] = a & 0x80 ? s : -s;
  }
  return t;
}

/** For every int16 value (offset by 32768), the code that decodes nearest to it. */
function encodeTable(decode: Int16Array): Uint8Array {
  const order = [...decode.keys()].sort((a, b) => decode[a]! - decode[b]! || a - b);
  const values = order.map((i) => decode[i]!);
  const table = new Uint8Array(65536);
  let j = 1;
  for (let x = -32768; x < 32768; x++) {
    while (j < values.length - 1 && values[j]! < x) j++;
    const nearest = x - values[j - 1]! <= values[j]! - x ? j - 1 : j;
    table[x + 32768] = order[nearest]!;
  }
  return table;
}

const DECODE: Record<G711, Int16Array> = { [PCMU]: ulawDecodeTable(), [PCMA]: alawDecodeTable() };
const ENCODE: Record<G711, Uint8Array> = {
  [PCMU]: encodeTable(DECODE[PCMU]),
  [PCMA]: encodeTable(DECODE[PCMA]),
};

/** G.711 bytes → int16 samples. */
export function decodeG711(payload: Uint8Array, pt: G711): Int16Array {
  const table = DECODE[pt];
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = table[payload[i]!]!;
  return out;
}

/** int16 samples → G.711 bytes. */
export function encodeG711(samples: Int16Array, pt: G711): Uint8Array {
  const table = ENCODE[pt];
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = table[samples[i]! + 32768]!;
  return out;
}
