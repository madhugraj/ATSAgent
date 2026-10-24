/**
 * Phone screening policy per organisation (docs/voice-screening-agent.md):
 * whether the Screening call agent may phone candidates, under which name,
 * and when. Defaults apply until the HR head saves a policy. Changes are
 * audited.
 */
import { eq } from "drizzle-orm";

import { phoneScreeningSettings } from "@db/schema";
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
};

export const DEFAULT_PHONE_SCREENING_POLICY: PhoneScreeningPolicy = {
  enabled: false,
  assistantName: "Saranya",
  windowStartMinute: 600,
  windowEndMinute: 1140,
  callDays: [1, 2, 3, 4, 5, 6],
  maxAttempts: 3,
  maxMinutes: 15,
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
  /** This deployment has a phone line (PBX extension) configured. */
  phoneLine: boolean;
  /** The organisation stored a credential for the AI voice. */
  voice: boolean;
  /** All three: calls can be placed. */
  ready: boolean;
};

/** Whether calls can be placed for the organisation, and what is missing. */
export async function phoneScreeningReadiness(orgId: string): Promise<PhoneScreeningReadiness> {
  const { voiceCredentialStatus } = await import("@/lib/ai-gateway.server");
  const [policy, cred] = await Promise.all([
    phoneScreeningPolicyOf(orgId),
    voiceCredentialStatus(orgId),
  ]);
  const phoneLine = sipConfigured();
  const voice = cred.serviceAccount || cred.apiKey;
  return { enabled: policy.enabled, phoneLine, voice, ready: policy.enabled && phoneLine && voice };
}
