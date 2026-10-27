/**
 * Just enough SIP to place one outbound call through Asterisk from an
 * extension — port of ai_interviewer/sip.py.
 *
 * It dials the way a softphone does — INVITE with digest auth, then ACK, BYE
 * and CANCEL — and answers the PBX's in-dialog requests. It never sends
 * REGISTER, so the extension's own softphone keeps receiving its calls.
 * Phone numbers never go to the log; `debug` prints raw SIP for diagnosis only.
 */
import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { isIP } from "node:net";

import { PCMA, PCMU, type G711 } from "./g711";
import { RtpStream, type Endpoint } from "./rtp";

const T1 = 500; // SIP retransmit base interval, ms
const COMPACT: Record<string, string> = {
  v: "via",
  f: "from",
  t: "to",
  i: "call-id",
  m: "contact",
  l: "content-length",
  c: "content-type",
};

export class CallFailed extends Error {}

const rand = (n = 10) =>
  [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export type SipMessage = {
  start: string;
  headers: [string, string][];
  body: string;
  isResponse: boolean;
  status: number;
  reason: string;
  method: string;
  get(name: string): string;
  all(name: string): string[];
  cseq: { num: number; method: string };
};

export function parseSipMessage(raw: string): SipMessage {
  const split = raw.indexOf("\r\n\r\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split + 4);
  const lines = head.split("\r\n");
  const start = lines[0] ?? "";
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.push([COMPACT[name] ?? name, line.slice(colon + 1).trim()]);
  }
  const isResponse = start.startsWith("SIP/2.0");
  const parts = start.split(" ");
  const get = (name: string) => headers.find(([k]) => k === name)?.[1] ?? "";
  const [num = "0", method = ""] = get("cseq").split(/\s+/);
  return {
    start,
    headers,
    body,
    isResponse,
    status: isResponse ? Number(parts[1]) : 0,
    reason: isResponse ? parts.slice(2).join(" ") : "",
    method: isResponse ? "" : (parts[0] ?? ""),
    get,
    all: (name) => headers.filter(([k]) => k === name).map(([, v]) => v),
    cseq: { num: Number(num) || 0, method: method.trim() },
  };
}

/** The Authorization header value answering a digest challenge (RFC 2617, MD5). */
export function digestAuthorization(
  challenge: string,
  method: string,
  uri: string,
  user: string,
  password: string,
  cnonce = rand(16),
): string {
  const params: Record<string, string> = {};
  for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g))
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  const realm = params["realm"] ?? "";
  const nonce = params["nonce"] ?? "";
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let header = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  if (
    (params["qop"] ?? "")
      .split(",")
      .map((q) => q.trim())
      .includes("auth")
  ) {
    const nc = "00000001";
    header += `, response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    header += `, response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  header += ", algorithm=MD5";
  if (params["opaque"] !== undefined) header += `, opaque="${params["opaque"]}"`;
  return header;
}

export function uriOf(headerValue: string): string {
  const m = headerValue.match(/<([^>]+)>/);
  return m ? m[1]! : (headerValue.split(";")[0] ?? "").trim();
}

/** Where to send audio and which codec, from an SDP answer. */
export function parseSdp(body: string): { remote: Endpoint; pt: G711 } | null {
  const ip = body.match(/^c=IN IP4 (\S+)/m);
  const media = body.match(/^m=audio (\d+) \S+ ([\d ]+)/m);
  if (!ip || !media) return null;
  const offered = media[2]!.trim().split(/\s+/).map(Number);
  const pt = offered.find((p) => p === PCMU || p === PCMA) as G711 | undefined;
  if (pt === undefined)
    throw new CallFailed(
      `PBX answered with codecs ${offered.join(",")}; only PCMU/PCMA are supported`,
    );
  return { remote: { address: ip[1]!, port: Number(media[1]) }, pt };
}

/** The address of the interface that routes to the PBX. Nothing is sent. */
export async function localIpTowards(host: string, port: number): Promise<string> {
  const s = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.connect(port, host, () => resolve());
    });
    return s.address().address;
  } finally {
    s.close();
  }
}

export type SipOptions = {
  server: string;
  port?: number;
  user: string;
  password: string;
  domain?: string;
  authUser?: string;
  displayName?: string;
  /** This machine's public address, only if calls have one-way audio (NAT). */
  publicIp?: string;
  debug?: boolean;
};

export type CallProgress = "ringing" | "progress";

export class SipCall {
  private sock = dgram.createSocket("udp4");
  private readonly port: number;
  private readonly domain: string;
  private readonly authUser: string;
  private readonly callId = `${rand(20)}@atsiq`;
  private readonly fromTag = rand();
  private toTag = "";
  private cseq = 0;
  private routeSet: string[] = [];
  private remoteTarget = "";
  private targetUri = "";
  private localIp = "";
  private localPort = 0;
  private ack: Uint8Array | null = null;
  private responses: SipMessage[] = [];
  private waiter: (() => void) | null = null;
  private endedResolve!: () => void;
  readonly ended: Promise<void> = new Promise((r) => (this.endedResolve = r));
  isEnded = false;
  endReason = "";
  rtp: RtpStream | null = null;

  constructor(private readonly o: SipOptions) {
    this.port = o.port ?? 5060;
    this.domain = o.domain || o.server;
    this.authUser = o.authUser || o.user;
  }

  /* ---- transport ---- */

  private async open() {
    this.localIp = this.o.publicIp || (await localIpTowards(this.o.server, this.port));
    await new Promise<void>((resolve, reject) => {
      this.sock.once("error", reject);
      this.sock.bind(0, () => resolve());
    });
    this.localPort = this.sock.address().port;
    // Only the PBX may talk to this socket (when it is addressed by IP).
    const pbx = isIP(this.o.server) ? this.o.server : null;
    this.sock.on("message", (data, rinfo) => {
      if (pbx && rinfo.address !== pbx) return;
      this.datagram(data.toString("utf8"));
    });
  }

  private datagram(raw: string) {
    if (!raw.trim()) return; // keep-alive
    if (this.o.debug) console.log(`\n<<< SIP\n${raw.trim()}`);
    let msg: SipMessage;
    try {
      msg = parseSipMessage(raw);
    } catch {
      return;
    }
    if (msg.isResponse) {
      // A retransmitted 200 means our ACK was lost — resend it.
      if (this.ack && msg.cseq.method === "INVITE" && msg.status >= 200 && msg.status < 300) {
        this.send(this.ack);
      } else {
        this.responses.push(msg);
        this.waiter?.();
      }
    } else {
      this.handleRequest(msg);
    }
  }

  private send(data: Uint8Array) {
    if (this.o.debug) console.log(`\n>>> SIP\n${new TextDecoder().decode(data).trim()}`);
    this.sock.send(data, this.port, this.o.server);
  }

  private async nextResponse(method: string, cseq: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.responses.findIndex((m) => m.cseq.num === cseq && m.cseq.method === method);
      if (i >= 0) return this.responses.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiter = null;
    }
  }

  /* ---- message building ---- */

  private from() {
    const name = this.o.displayName ? `"${this.o.displayName.replace(/"/g, "")}" ` : "";
    return `${name}<sip:${this.o.user}@${this.domain}>;tag=${this.fromTag}`;
  }

  private to() {
    return `<${this.targetUri}>` + (this.toTag ? `;tag=${this.toTag}` : "");
  }

  private request(
    method: string,
    uri: string,
    branch: string,
    cseq: number,
    opts: { to?: string; extra?: string[]; body?: string; routes?: string[] } = {},
  ): Uint8Array {
    const body = opts.body ?? "";
    const lines = [
      `${method} ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branch}`,
      "Max-Forwards: 70",
      `From: ${this.from()}`,
      `To: ${opts.to ?? this.to()}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <sip:${this.o.user}@${this.localIp}:${this.localPort}>`,
      ...(opts.routes ?? []).map((r) => `Route: ${r}`),
      "User-Agent: atsiq-voice",
      ...(opts.extra ?? []),
    ];
    if (body) lines.push("Content-Type: application/sdp");
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    return Buffer.from(lines.join("\r\n") + "\r\n\r\n" + body);
  }

  private sdp(): string {
    const sid = String(Math.floor(Math.random() * 2 ** 32));
    return (
      [
        "v=0",
        `o=- ${sid} ${sid} IN IP4 ${this.localIp}`,
        "s=atsiq-voice",
        `c=IN IP4 ${this.localIp}`,
        "t=0 0",
        `m=audio ${this.rtp!.port} RTP/AVP ${PCMU} ${PCMA}`,
        `a=rtpmap:${PCMU} PCMU/8000`,
        `a=rtpmap:${PCMA} PCMA/8000`,
        "a=ptime:20",
        "a=sendrecv",
      ].join("\r\n") + "\r\n"
    );
  }

  private reply(req: SipMessage, status: number, reason: string, body = "") {
    let to = req.get("to");
    if (!to.includes(";tag=")) to += `;tag=${this.fromTag}`;
    const lines = [
      `SIP/2.0 ${status} ${reason}`,
      ...req.all("via").map((v) => `Via: ${v}`),
      `From: ${req.get("from")}`,
      `To: ${to}`,
      `Call-ID: ${req.get("call-id")}`,
      `CSeq: ${req.get("cseq")}`,
      `Contact: <sip:${this.o.user}@${this.localIp}:${this.localPort}>`,
      "User-Agent: atsiq-voice",
    ];
    if (body) lines.push("Content-Type: application/sdp");
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    this.send(Buffer.from(lines.join("\r\n") + "\r\n\r\n" + body));
  }

  /* ---- requests from the PBX ---- */

  private handleRequest(req: SipMessage) {
    // Only this call's dialog: anything else on the socket is refused.
    if (req.get("call-id") !== this.callId) {
      if (req.method !== "ACK") this.reply(req, 481, "Call/Transaction Does Not Exist");
      return;
    }
    switch (req.method) {
      case "BYE":
        this.reply(req, 200, "OK");
        this.finish("the other side hung up");
        break;
      case "INVITE": {
        // re-INVITE: media may have moved
        let sdp: ReturnType<typeof parseSdp> = null;
        try {
          sdp = req.body ? parseSdp(req.body) : null;
        } catch {
          sdp = null;
        }
        if (sdp && this.rtp) {
          this.rtp.trust(sdp.remote.address);
          this.rtp.remote = sdp.remote;
        }
        this.reply(req, 200, "OK", this.rtp ? this.sdp() : "");
        break;
      }
      case "ACK":
        break;
      case "OPTIONS":
      case "INFO":
      case "UPDATE":
      case "NOTIFY":
      case "CANCEL":
        this.reply(req, 200, "OK");
        break;
      default:
        this.reply(req, 501, "Not Implemented");
    }
  }

  /* ---- dialling ---- */

  /** Resolves once the call is answered; throws CallFailed otherwise. */
  async dial(number: string, ringTimeoutMs = 60_000, onProgress?: (p: CallProgress) => void) {
    await this.open();
    this.rtp = new RtpStream(new Set([this.o.server]));
    await this.rtp.bind();
    this.targetUri = `sip:${number}@${this.domain}`;

    let auth: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      this.cseq += 1;
      const branch = "z9hG4bK" + rand(16);
      const final = await this.invite(branch, auth, ringTimeoutMs, onProgress);
      if (final.status >= 200 && final.status < 300) {
        this.answered(final);
        return;
      }
      this.send(this.request("ACK", this.targetUri, branch, this.cseq, { to: final.get("to") }));
      if ((final.status === 401 || final.status === 407) && attempt === 0) {
        const header = final.status === 401 ? "www-authenticate" : "proxy-authenticate";
        const name = final.status === 401 ? "Authorization" : "Proxy-Authorization";
        auth = [
          `${name}: ${digestAuthorization(final.get(header), "INVITE", this.targetUri, this.authUser, this.o.password)}`,
        ];
        continue;
      }
      if ([401, 403, 407].includes(final.status))
        throw new CallFailed(`${final.status} ${final.reason} — check the SIP user and password`);
      throw new CallFailed(`${final.status} ${final.reason}`);
    }
    throw new CallFailed("authentication failed");
  }

  private async invite(
    branch: string,
    auth: string[],
    ringTimeoutMs: number,
    onProgress?: (p: CallProgress) => void,
  ): Promise<SipMessage> {
    const invite = this.request("INVITE", this.targetUri, branch, this.cseq, {
      extra: ["Allow: INVITE, ACK, BYE, CANCEL, OPTIONS", ...auth],
      body: this.sdp(),
    });
    // Retransmit until the PBX says anything at all.
    let interval = T1;
    let waited = 0;
    let msg: SipMessage | null = null;
    while (!msg) {
      this.send(invite);
      msg = await this.nextResponse("INVITE", this.cseq, interval);
      waited += interval;
      interval = Math.min(interval * 2, 4000);
      if (!msg && waited > 16_000)
        throw new CallFailed(
          `no reply from ${this.o.server}:${this.port} — is UDP reachable from here?`,
        );
    }

    const started = Date.now();
    let cancelled = false;
    while (msg.status < 200) {
      if (msg.status === 180) onProgress?.("ringing");
      else if (msg.status === 183) onProgress?.("progress");
      const left = ringTimeoutMs - (Date.now() - started);
      if (left <= 0 && !cancelled) {
        this.send(this.request("CANCEL", this.targetUri, branch, this.cseq));
        cancelled = true;
      }
      const next = await this.nextResponse(
        "INVITE",
        this.cseq,
        cancelled ? 10_000 : Math.max(left, 0),
      );
      if (!next) {
        if (cancelled) throw new CallFailed("no answer");
        continue;
      }
      msg = next;
    }
    if (cancelled && msg.status === 487) throw new CallFailed("no answer");
    return msg;
  }

  private answered(ok: SipMessage) {
    this.toTag = ok.get("to").match(/;tag=([^;\s]+)/)?.[1] ?? "";
    this.remoteTarget = uriOf(ok.get("contact")) || this.targetUri;
    this.routeSet = ok
      .all("record-route")
      .reverse()
      .flatMap((rr) => rr.split(",").map((r) => r.trim()));
    this.ack = this.request("ACK", this.remoteTarget, "z9hG4bK" + rand(16), this.cseq, {
      routes: this.routeSet,
    });
    this.send(this.ack);
    const sdp = parseSdp(ok.body);
    if (!sdp) throw new CallFailed("answered without audio details (no SDP)");
    this.rtp!.start(sdp.remote, sdp.pt);
  }

  /* ---- ending ---- */

  async hangup() {
    if (this.isEnded || !this.ack) {
      this.finish("hung up");
      return;
    }
    let auth: string[] = [];
    for (let i = 0; i < 2; i++) {
      this.cseq += 1;
      const bye = this.request("BYE", this.remoteTarget, "z9hG4bK" + rand(16), this.cseq, {
        routes: this.routeSet,
        extra: auth,
      });
      let reply: SipMessage | null = null;
      for (const wait of [T1, T1 * 2, T1 * 4]) {
        this.send(bye);
        reply = await this.nextResponse("BYE", this.cseq, wait);
        if (reply) break;
      }
      if (reply && (reply.status === 401 || reply.status === 407)) {
        const header = reply.status === 401 ? "www-authenticate" : "proxy-authenticate";
        const name = reply.status === 401 ? "Authorization" : "Proxy-Authorization";
        auth = [
          `${name}: ${digestAuthorization(reply.get(header), "BYE", this.remoteTarget, this.authUser, this.o.password)}`,
        ];
        continue;
      }
      break;
    }
    this.finish("hung up");
  }

  private finish(reason: string) {
    if (!this.isEnded) {
      this.isEnded = true;
      this.endReason = reason;
      this.endedResolve();
    }
    this.rtp?.stop();
  }

  close() {
    this.rtp?.stop();
    try {
      this.sock.close();
    } catch {
      // already closed
    }
  }

  /** Send an OPTIONS and report what comes back — checks the PBX is reachable. */
  static async ping(server: string, port = 5060): Promise<string> {
    const call = new SipCall({ server, port, user: "ping", password: "" });
    await call.open();
    call.targetUri = `sip:${server}`;
    try {
      for (const wait of [T1, T1 * 2, T1 * 4]) {
        call.send(call.request("OPTIONS", call.targetUri, "z9hG4bK" + rand(16), 1));
        const reply = await call.nextResponse("OPTIONS", 1, wait);
        if (reply) {
          const server = reply.get("server") || reply.get("user-agent") || "unknown";
          return `reachable — ${reply.status} ${reply.reason} (server: ${server})`;
        }
      }
      return "no reply — UDP 5060 may be blocked from this network";
    } finally {
      call.close();
    }
  }
}
