/** The production phone line: one SIP call through the PBX extension in SIP_* settings. */
import { env } from "../env";
import type { PhoneLine } from "./call-session.server";
import { SipCall } from "./sip";

export function sipLine(): PhoneLine {
  if (!env.SIP_SERVER || !env.SIP_USER || !env.SIP_PASSWORD)
    throw new Error("No phone line is configured (SIP_SERVER, SIP_USER, SIP_PASSWORD).");
  const call = new SipCall({
    server: env.SIP_SERVER,
    port: env.SIP_PORT,
    user: env.SIP_USER,
    password: env.SIP_PASSWORD,
    ...(env.SIP_DOMAIN ? { domain: env.SIP_DOMAIN } : {}),
    ...(env.SIP_AUTH_USER ? { authUser: env.SIP_AUTH_USER } : {}),
    ...(env.SIP_CALLER_NAME ? { displayName: env.SIP_CALLER_NAME } : {}),
    ...(env.SIP_PUBLIC_IP ? { publicIp: env.SIP_PUBLIC_IP } : {}),
  });
  let listener: (pcm: Int16Array) => void = () => {};
  return {
    dial: async (number, ringTimeoutMs) => {
      await call.dial(number, ringTimeoutMs);
      call.rtp!.onAudio = (pcm) => listener(pcm);
    },
    onAudio: (cb) => {
      listener = cb;
    },
    play: (pcm) => call.rtp?.play(pcm),
    clear: () => call.rtp?.clear(),
    pendingSeconds: () => call.rtp?.pendingSeconds() ?? 0,
    ended: call.ended,
    hangup: () => call.hangup(),
    close: () => call.close(),
  };
}
