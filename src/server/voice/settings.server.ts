/**
 * Phone screening policy per organisation (docs/voice-screening-agent.md):
 * whether the Screening call agent may phone candidates, under which name,
 * and when. Defaults apply until the HR head saves a policy. Changes are
 * audited.
 */
import { eq, gt, sql } from "drizzle-orm";

import { phoneScreeningSettings, voiceWorkerHeartbeat } from "@db/schema";
import { writeAudit } from "../audit";
import { db } from "../db";
import { sipConfigured } from "../env";

export type PhoneScreeningPolicy = {
  enabled: boolean;
  assistantName: string;
  /** Minutes after midnight in the organisation's time zone. */
  windowStartMinute: number;
  windowEndMinute: number;
  /** ISO weekdays (1 = Monday … 7 = Sunday). */
  callDays: number[];
  maxAttempts: number;
  maxMinutes: number;
  /** Times a candidate may move the call; then the written assessment or a person is offered. */
  maxReschedules: number;
  /** The assistant's voice. */
  voice: string;
  /** What candidates are told happens next; null = a plain default. */
  nextStepsText: string | null;
};

/** Voices the assistant may use (the voice service's prebuilt voices). */
export const ASSISTANT_VOICES = [
  "Kore",
  "Aoede",
  "Leda",
  "Zephyr",
  "Puck",
  "Charon",
  "Fenrir",
  "Orus",
] as const;

export const DEFAULT_PHONE_SCREENING_POLICY: PhoneScreeningPolicy = {
  enabled: false,
  assistantName: "Saranya",
  windowStartMinute: 600,
  windowEndMinute: 1140,
  callDays: [1, 2, 3, 4, 5, 6],
  maxAttempts: 3,
  maxMinutes: 10,
  maxReschedules: 2,
  voice: "Kore",
  nextStepsText: null,
};

export async function phoneScreeningPolicyOf(orgId: string): Promise<PhoneScreeningPolicy> {
  const [r] = await db
    .select()
    .from(phoneScreeningSettings)
    .where(eq(phoneScreeningSettings.orgId, orgId))
    .limit(1);
  if (!r) return DEFAULT_PHONE_SCREENING_POLICY;
  return {
    enabled: r.enabled,
    assistantName: r.assistantName,
    windowStartMinute: r.windowStartMinute,
    windowEndMinute: r.windowEndMinute,
    callDays: [...r.callDays].sort((a, b) => a - b),
    maxAttempts: r.maxAttempts,
    maxMinutes: r.maxMinutes,
    maxReschedules: r.maxReschedules,
    voice: r.voice,
    nextStepsText: r.nextStepsText,
  };
}

export type PolicyActor = { userId: string; memberEmail: string };

/** Save the organisation's policy (callers check the role). Audited. */
export async function setPhoneScreeningPolicyCore(
  orgId: string,
  actor: PolicyActor,
  policy: PhoneScreeningPolicy,
): Promise<void> {
  const values = {
    ...policy,
    assistantName: policy.assistantName.trim(),
    nextStepsText: policy.nextStepsText?.trim() || null,
    callDays: [...new Set(policy.callDays)].sort((a, b) => a - b),
  };
  const now = new Date();
  await db
    .insert(phoneScreeningSettings)
    .values({ orgId, ...values, updatedBy: actor.userId, updatedAt: now })
    .onConflictDoUpdate({
      target: phoneScreeningSettings.orgId,
      set: { ...values, updatedBy: actor.userId, updatedAt: now },
    });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId,
    action: "screening_call.settings.set",
    entityType: "phone_screening_settings",
    entityId: orgId,
    detail: values,
  });
}

export type PhoneScreeningReadiness = {
  /** The organisation switched phone screening on. */
  enabled: boolean;
  /** A voice worker with a phone line is running (it beat in the last two minutes). */
  phoneLine: boolean;
  /** The organisation stored a credential for the AI voice. */
  voice: boolean;
  /** All three: calls can be placed. */
  ready: boolean;
};

/** A voice worker beat in the last two minutes (it holds the phone line; the app does not). */
export async function voiceWorkerAlive(now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceWorkerHeartbeat)
    .where(gt(voiceWorkerHeartbeat.lastSeen, new Date(now.getTime() - 120_000)));
  return (row?.n ?? 0) > 0;
}

/** Record this worker's beat (called by the voice worker every poll). */
export async function beat(workerId: string, maxConcurrent: number, callsInProgress: number) {
  const now = new Date();
  await db
    .insert(voiceWorkerHeartbeat)
    .values({ workerId, lastSeen: now, maxConcurrent, callsInProgress })
    .onConflictDoUpdate({
      target: voiceWorkerHeartbeat.workerId,
      set: { lastSeen: now, maxConcurrent, callsInProgress },
    });
}

/** Whether calls can be placed for the organisation, and what is missing. */
export async function phoneScreeningReadiness(orgId: string): Promise<PhoneScreeningReadiness> {
  const { voiceCredentialStatus } = await import("@/lib/ai-gateway.server");
  const [policy, cred] = await Promise.all([
    phoneScreeningPolicyOf(orgId),
    voiceCredentialStatus(orgId),
  ]);
  const phoneLine = sipConfigured() || (await voiceWorkerAlive());
  const voice = cred.serviceAccount || cred.apiKey;
  return { enabled: policy.enabled, phoneLine, voice, ready: policy.enabled && phoneLine && voice };
}
