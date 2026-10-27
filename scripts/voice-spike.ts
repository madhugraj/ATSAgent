/**
 * M0 spike (docs/voice-screening-agent.md): place a phone call through the
 * Asterisk PBX and let the live voice model talk — the TypeScript port of
 * ai_interviewer/call.py, with the model reached only through the AI gateway
 * (aiVoiceSession), so the call lands in the ledger like any other AI call.
 *
 *   bun --env-file=ai_interviewer/.env scripts/voice-spike.ts --check
 *   bun --env-file=ai_interviewer/.env scripts/voice-spike.ts --live-only
 *   bun --env-file=ai_interviewer/.env scripts/voice-spike.ts 9876543210 --name Ravi
 *
 * Needs DATABASE_URL (the ledger row) besides the POC's SIP_* settings and
 * its voice credentials (API key or Vertex service account); VOICE_MODEL
 * overrides the model. Phone numbers are printed
 * masked. A spike, not the product: no candidate, kit, consent or org yet.
 */
import { readFileSync, existsSync } from "node:fs";

import {
  aiVoiceSession,
  DEFAULT_VOICE_MODEL,
  type VertexServiceAccount,
  type VoiceSession,
} from "../src/lib/ai-gateway.server";
import { Resampler } from "../src/server/voice/resample";
import { CallFailed, SipCall } from "../src/server/voice/sip";

const env = (name: string, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SIP_SERVER = env("SIP_SERVER");
const SIP_PORT = Number(env("SIP_PORT", "5060"));
const RING_TIMEOUT_MS = Number(env("RING_TIMEOUT", "60")) * 1000;
const MAX_CALL_MS = Number(env("MAX_CALL_SECONDS", "600")) * 1000;

const PROMPT_FILE = option("--prompt") ?? "ai_interviewer/prompt.txt";
const FALLBACK_PROMPT = [
  "You are an AI assistant calling a job candidate on behalf of the HR team. This is a test call.",
  "In your first sentence say you are an AI assistant. Keep replies to one or two sentences.",
  "Never invent a company, role, salary or any other detail. Say goodbye, then call end_call.",
].join("\n");

const END_CALL = {
  name: "end_call",
  description: "Hang up the phone. Say goodbye out loud first, then call this.",
};

const masked = (n: string) => (n.length > 4 ? `${"•".repeat(n.length - 4)}${n.slice(-4)}` : "••••");

/** The PBX dial plan takes ten digits for Indian mobiles. */
function national(number: string): string {
  const d = number.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d;
}

function prompt(name?: string): string {
  const text = existsSync(PROMPT_FILE)
    ? readFileSync(PROMPT_FILE, "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n")
        .trim()
    : FALLBACK_PROMPT;
  return name ? `${text}\n\nThe person you are calling is named ${name}.` : text;
}

/**
 * The voice model's credentials: an API key (GEMINI_API_KEY), else — as the
 * POC runs — Vertex AI with the service-account file it names
 * (GOOGLE_APPLICATION_CREDENTIALS, looked up here or under ai_interviewer/).
 */
function voiceAuth() {
  const model = env("VOICE_MODEL", env("GEMINI_MODEL", DEFAULT_VOICE_MODEL));
  const apiKey = env("GEMINI_API_KEY");
  if (apiKey.length > 10) return { config: { provider: "google" as const, model, apiKey } };
  if (env("GOOGLE_GENAI_USE_VERTEXAI").toLowerCase() === "true") {
    const file = env("GOOGLE_APPLICATION_CREDENTIALS");
    const path = [file, `ai_interviewer/${file}`].find((p) => p && existsSync(p));
    if (!path) throw new Error(`Service-account file not found: ${file}`);
    return {
      config: { provider: "google" as const, model, apiKey: null },
      vertex: {
        project: env("GOOGLE_CLOUD_PROJECT"),
        location: env("GOOGLE_CLOUD_LOCATION", "us-central1"),
        serviceAccount: JSON.parse(readFileSync(path, "utf8")) as VertexServiceAccount,
      },
    };
  }
  throw new Error("Set GEMINI_API_KEY, or the GOOGLE_* Vertex settings, in the env file.");
}

function report(summary: Awaited<VoiceSession["done"]>) {
  console.log(
    `\nSession closed by ${summary.closedBy}${summary.error ? ` (${summary.error})` : ""}: ` +
      `${summary.transcript.length} transcript lines, ${summary.toolCalls.length} tool calls, ` +
      `usage ${summary.usage ? `${summary.usage.promptTokens} in / ${summary.usage.completionTokens} out / ${summary.usage.totalTokens} total` : "not reported"}.`,
  );
}

/** No phone: open a session, ask for a one-line hello, close. Proves the gateway path. */
async function liveOnly() {
  let audioSamples = 0;
  let spoke!: () => void;
  const aiSpoke = new Promise<void>((r) => (spoke = r));
  const opened = await aiVoiceSession({
    orgId: null,
    feature: "screening_call",
    system: FALLBACK_PROMPT,
    tools: [END_CALL],
    ...voiceAuth(),
    events: {
      onAudio: (pcm) => (audioSamples += pcm.length),
      onTurn: (t) => {
        console.log(`${t.who === "ai" ? "AI" : "Caller"}: ${t.text}`);
        if (t.who === "ai") spoke();
      },
    },
  });
  if (!opened.ok) throw new Error(opened.message);
  console.log("Voice session ready.");
  opened.session.sendText("Please say a one-sentence hello to test the line.");
  await Promise.race([aiSpoke, opened.session.done, new Promise((r) => setTimeout(r, 30_000))]);
  console.log(`Received ${(audioSamples / 24000).toFixed(1)} s of speech.`);
  report(await opened.session.close());
}

async function call(number: string, name?: string) {
  for (const k of ["SIP_SERVER", "SIP_USER", "SIP_PASSWORD"])
    if (!env(k)) throw new Error(`Set ${k} in the env file.`);
  const target = flag("--raw") ? number.trim() : national(number);
  const sip = new SipCall({
    server: SIP_SERVER,
    port: SIP_PORT,
    user: env("SIP_USER"),
    password: env("SIP_PASSWORD"),
    domain: env("SIP_DOMAIN"),
    authUser: env("SIP_AUTH_USER"),
    displayName: env("CALLER_NAME"),
    publicIp: env("PUBLIC_IP"),
    debug: env("SIP_DEBUG") === "1",
  });
  const up = new Resampler(2, 1); // 8 kHz phone → 16 kHz model
  const down = new Resampler(1, 3); // 24 kHz model → 8 kHz phone
  let hungUpByAi!: () => void;
  const aiEnded = new Promise<string>((r) => (hungUpByAi = () => r("the AI ended the call")));
  const t0 = Date.now();

  // Connect the model while the phone rings, so it speaks the moment they answer.
  const opened = await aiVoiceSession({
    orgId: null,
    feature: "screening_call",
    system: prompt(name),
    tools: [END_CALL],
    ...voiceAuth(),
    events: {
      onAudio: (pcm) => sip.rtp?.play(down.process(pcm)),
      onInterrupted: () => sip.rtp?.clear(),
      onTurn: (t) =>
        console.log(
          `${t.who === "ai" ? "AI" : "Caller"}: ${t.text}${t.interrupted ? " …(interrupted)" : ""}`,
        ),
      onToolCall: async (c) => {
        if (c.name !== "end_call") return { ok: false, error: "unknown tool" };
        // The goodbye is already queued; let it finish playing.
        while ((sip.rtp?.pendingSeconds() ?? 0) > 0) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 600));
        hungUpByAi();
        return { ok: true };
      },
      onGoAway: (left) => console.log(`(voice session closing in ${left})`),
    },
  });
  if (!opened.ok) throw new Error(opened.message);
  const session = opened.session;
  console.log(`Voice session ready. Dialling ${masked(target)} via ${SIP_SERVER}…`);

  let why = "";
  try {
    try {
      await sip.dial(target, RING_TIMEOUT_MS, (p) =>
        console.log(p === "ringing" ? "  ringing…" : "  call progressing…"),
      );
    } catch (e) {
      if (e instanceof CallFailed) {
        console.log(`Call failed: ${e.message}`);
        return;
      }
      throw e;
    }
    console.log(`Answered after ${((Date.now() - t0) / 1000).toFixed(1)} s — AI is talking.\n`);
    sip.rtp!.onAudio = (pcm) => session.sendAudio(up.process(pcm));
    session.sendText("(The person has just picked up the phone. Greet them and begin.)");
    why = await Promise.race([
      aiEnded,
      sip.ended.then(() => sip.endReason),
      session.done.then((s) => `the voice session closed${s.error ? ` (${s.error})` : ""}`),
      new Promise<string>((r) =>
        setTimeout(() => r(`reached the ${MAX_CALL_MS / 1000}s limit`), MAX_CALL_MS),
      ),
    ]);
  } finally {
    await sip.hangup();
    sip.close();
    console.log(`\nCall ended (${why || sip.endReason || "not connected"}).`);
    report(await session.close());
  }
}

async function main() {
  if (flag("--check")) {
    if (!SIP_SERVER) throw new Error("Set SIP_SERVER in the env file.");
    console.log(`${SIP_SERVER}:${SIP_PORT} —`, await SipCall.ping(SIP_SERVER, SIP_PORT));
    return;
  }
  if (flag("--live-only")) return liveOnly();
  const number = args.find(
    (a) =>
      !a.startsWith("--") &&
      args[args.indexOf(a) - 1] !== "--name" &&
      args[args.indexOf(a) - 1] !== "--prompt",
  );
  if (!number) throw new Error("Give a phone number, --check or --live-only.");
  return call(number, option("--name"));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
