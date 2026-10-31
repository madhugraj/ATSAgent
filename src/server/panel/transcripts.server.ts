/**
 * Silent panel agents, S1 (docs/silent-panel-agent-plan.md): the switch per
 * organisation, transcription per round, and fetching the call's transcript
 * after it ends. Plain code — no AI here. The panel agents (S2) read what this
 * stores.
 *
 * A round is transcribed when the agent is on for its level and its meeting is
 * on a provider we can read back. Transcription is switched on with the
 * provider right after booking; a candidate who declines has it switched off
 * and any stored transcript deleted. After the call the sweep asks the
 * provider every 10 minutes, then less often, for up to 6 hours; then the
 * round is marked unavailable (health rule panel.transcript_missing).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  applications,
  interviews,
  interviewTranscripts,
  panelAgentSettings,
  sourceIntegrations,
} from "@db/schema";
import type { MeetingRef } from "@/lib/meeting-ref";
import { writeAudit } from "../audit";
import { db } from "../db";
import { log } from "../log";

export type PanelAgentPolicy = { enabled: boolean; levels: number[] };

export const DEFAULT_PANEL_AGENT_POLICY: PanelAgentPolicy = { enabled: false, levels: [1, 2, 3] };

/** Hours after a call's end before an absent transcript is given up on. */
export const TRANSCRIPT_WAIT_HOURS = 6;

export async function panelAgentPolicyOf(orgId: string): Promise<PanelAgentPolicy> {
  const [r] = await db
    .select({ enabled: panelAgentSettings.enabled, levels: panelAgentSettings.levels })
    .from(panelAgentSettings)
    .where(eq(panelAgentSettings.orgId, orgId))
    .limit(1);
  return r ? { enabled: r.enabled, levels: [...r.levels].sort() } : DEFAULT_PANEL_AGENT_POLICY;
}

export async function setPanelAgentPolicyCore(
  orgId: string,
  actor: { userId: string; memberEmail: string },
  policy: PanelAgentPolicy,
): Promise<void> {
  const before = await panelAgentPolicyOf(orgId);
  const levels = [...new Set(policy.levels)].sort();
  await db
    .insert(panelAgentSettings)
    .values({ orgId, enabled: policy.enabled, levels, updatedBy: actor.userId })
    .onConflictDoUpdate({
      target: panelAgentSettings.orgId,
      set: { enabled: policy.enabled, levels, updatedBy: actor.userId, updatedAt: new Date() },
    });
  await writeAudit({
    actor: actor.memberEmail,
    actorUserId: actor.userId,
    orgId,
    action: "panel_agent.settings_changed",
    entityType: "panel_agent_settings",
    entityId: orgId,
    detail: { before, after: { enabled: policy.enabled, levels } },
  });
}

/* ------------------------------------------------------------- credentials */

const PROVIDERS = ["zoom", "google_meet", "teams"] as const;
type Provider = (typeof PROVIDERS)[number];

async function secretsFor(orgId: string, provider: Provider) {
  const [row] = await db
    .select({
      id: sourceIntegrations.id,
      enabled: sourceIntegrations.enabled,
      ready: sourceIntegrations.hasCredentials,
    })
    .from(sourceIntegrations)
    .where(and(eq(sourceIntegrations.orgId, orgId), eq(sourceIntegrations.provider, provider)))
    .limit(1);
  if (!row?.enabled || !row.ready) return null;
  const { readSecrets } = await import("@/lib/integrations.server");
  return readSecrets(row.id);
}

/** What a connection's grant must include to switch transcription on and read it back. */
export const TRANSCRIPT_SCOPES: Record<Provider, string[]> = {
  teams: ["OnlineMeetingTranscript.Read.All"],
  google_meet: ["meetings.space.readonly", "meetings.space.settings"],
  // Zoom's scopes are set on the Zoom app itself, not asked for when connecting.
  zoom: [],
};

/**
 * Per connected meeting provider: whether its grant lets the agent read
 * transcripts. "unknown" when the grant does not say (Zoom, or app
 * credentials saved by hand) — the first round shows it.
 */
export async function panelAgentReadiness(orgId: string) {
  const rows = await db
    .select({
      id: sourceIntegrations.id,
      provider: sourceIntegrations.provider,
      label: sourceIntegrations.label,
      enabled: sourceIntegrations.enabled,
      ready: sourceIntegrations.hasCredentials,
    })
    .from(sourceIntegrations)
    .where(
      and(
        eq(sourceIntegrations.orgId, orgId),
        inArray(sourceIntegrations.provider, [...PROVIDERS]),
      ),
    );
  const { readSecrets } = await import("@/lib/integrations.server");
  const out: {
    provider: Provider;
    label: string;
    transcripts: "granted" | "missing" | "unknown";
  }[] = [];
  for (const r of rows) {
    if (!r.enabled || !r.ready) continue;
    const provider = r.provider as Provider;
    const need = TRANSCRIPT_SCOPES[provider];
    const scope = (await readSecrets(r.id))["scope"] ?? "";
    out.push({
      provider,
      label: r.label,
      transcripts:
        !need.length || !scope
          ? "unknown"
          : need.every((n) => scope.includes(n))
            ? "granted"
            : "missing",
    });
  }
  return out;
}

/* ---------------------------------------------------------- per round */

function refOf(r: {
  meetingProvider: string | null;
  meetingExternalId: string | null;
}): MeetingRef | null {
  return r.meetingProvider && r.meetingExternalId
    ? {
        meetingProvider: r.meetingProvider as Provider,
        meetingExternalId: r.meetingExternalId,
      }
    : null;
}

/**
 * After a round is booked or moved: transcription is requested when the agent
 * is on for its level and the meeting can be read back; otherwise it is off.
 * A declined or already transcribed round is left alone. Best-effort with the
 * provider: if it cannot be switched on, the round still waits for a
 * transcript (someone may start it in the call) and says why.
 */
export async function syncRoundTranscription(orgId: string, interviewId: string): Promise<void> {
  const [r] = await db
    .select({
      level: interviews.level,
      mode: interviews.mode,
      transcription: interviews.transcription,
      meetingProvider: interviews.meetingProvider,
      meetingExternalId: interviews.meetingExternalId,
    })
    .from(interviews)
    .where(and(eq(interviews.orgId, orgId), eq(interviews.id, interviewId)))
    .limit(1);
  if (!r || r.transcription === "ready" || r.transcription === "candidate_declined") return;
  const policy = await panelAgentPolicyOf(orgId);
  const ref = r.mode === "online" ? refOf(r) : null;
  const reset = { transcriptChecks: 0, transcriptCheckedAt: null };
  if (!policy.enabled || !policy.levels.includes(r.level) || !ref) {
    if (r.transcription !== "off")
      await db
        .update(interviews)
        .set({ transcription: "off", transcriptionDetail: null, ...reset })
        .where(and(eq(interviews.orgId, orgId), eq(interviews.id, interviewId)));
    return;
  }
  const secrets = await secretsFor(orgId, ref.meetingProvider);
  let detail: string | null = null;
  if (!secrets) {
    detail = "The meeting provider is not connected, so transcription could not be switched on.";
  } else {
    const { setMeetingTranscription } = await import("@/lib/meeting-transcripts.server");
    const res = await setMeetingTranscription(ref, secrets, true);
    if (!res.ok)
      detail = `Transcription could not be switched on automatically (${res.detail}) — start it in the call.`;
  }
  await db
    .update(interviews)
    .set({ transcription: "requested", transcriptionDetail: detail, ...reset })
    .where(and(eq(interviews.orgId, orgId), eq(interviews.id, interviewId)));
}

/**
 * The candidate does not want the call transcribed: switched off with the
 * provider (best-effort), any stored transcript deleted, audited. The round
 * goes ahead; the panel's verdict applies as it always has.
 */
export async function declineRoundTranscriptionCore(
  ctx: { orgId: string; userId: string; email: string },
  interviewId: string,
  note: string,
): Promise<void> {
  const [r] = await db
    .select({
      level: interviews.level,
      transcription: interviews.transcription,
      meetingProvider: interviews.meetingProvider,
      meetingExternalId: interviews.meetingExternalId,
    })
    .from(interviews)
    .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, interviewId)))
    .limit(1);
  if (!r) throw new Error("Interview round not found.");
  if (r.transcription === "candidate_declined") return;
  const ref = refOf(r);
  if (ref && r.transcription === "requested") {
    const secrets = await secretsFor(ctx.orgId, ref.meetingProvider);
    if (secrets) {
      const { setMeetingTranscription } = await import("@/lib/meeting-transcripts.server");
      const res = await setMeetingTranscription(ref, secrets, false);
      if (!res.ok)
        log.warn("panel.transcription_off_failed", { org_id: ctx.orgId, detail: res.detail });
    }
  }
  await db
    .delete(interviewTranscripts)
    .where(
      and(
        eq(interviewTranscripts.orgId, ctx.orgId),
        eq(interviewTranscripts.interviewId, interviewId),
      ),
    );
  await db
    .update(interviews)
    .set({ transcription: "candidate_declined", transcriptionDetail: note || null })
    .where(and(eq(interviews.orgId, ctx.orgId), eq(interviews.id, interviewId)));
  await writeAudit({
    actor: ctx.email,
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    action: "interview.transcription_declined",
    entityType: "interview",
    entityId: interviewId,
    detail: { level: r.level, was: r.transcription, note: note || null },
  });
}

/* ------------------------------------------------------------------ sweep */

/**
 * Rounds whose call has ended and whose transcript is due a check: 10 min
 * after the end, then doubling, at most every 2 hours; given up 6 hours after
 * the end. Only organisations with the agent switched on.
 */
export async function sweepTranscripts(onlyOrgId?: string, max = 20): Promise<number> {
  const due = await db
    .select({
      id: interviews.id,
      orgId: interviews.orgId,
      applicationId: interviews.applicationId,
      level: interviews.level,
      meetingProvider: interviews.meetingProvider,
      meetingExternalId: interviews.meetingExternalId,
      endsAt: sql<Date>`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins})`,
      requisitionId: applications.requisitionId,
    })
    .from(interviews)
    .innerJoin(panelAgentSettings, eq(panelAgentSettings.orgId, interviews.orgId))
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .where(
      and(
        eq(panelAgentSettings.enabled, true),
        eq(interviews.transcription, "requested"),
        inArray(interviews.status, ["scheduled", "rescheduled", "completed"]),
        sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins} + 10) < now()`,
        sql`(${interviews.transcriptCheckedAt} is null or ${interviews.transcriptCheckedAt} <
          now() - least(interval '10 minutes' * power(2, ${interviews.transcriptChecks}), interval '2 hours'))`,
        onlyOrgId ? eq(interviews.orgId, onlyOrgId) : undefined,
      ),
    )
    .orderBy(interviews.scheduledAt)
    .limit(max);

  const { fetchTranscript } = await import("@/lib/meeting-transcripts.server");
  const secretsCache = new Map<string, Record<string, string> | null>();
  let ready = 0;
  for (const r of due) {
    const orgId = r.orgId!;
    const where = and(eq(interviews.orgId, orgId), eq(interviews.id, r.id));
    const giveUp = new Date(r.endsAt).getTime() + TRANSCRIPT_WAIT_HOURS * 3600_000 < Date.now();
    const ref = refOf(r);
    let result: Awaited<ReturnType<typeof fetchTranscript>>;
    if (!ref) {
      result = { status: "unavailable", detail: "The round has no meeting we can read back." };
    } else {
      const key = `${orgId}:${ref.meetingProvider}`;
      if (!secretsCache.has(key))
        secretsCache.set(key, await secretsFor(orgId, ref.meetingProvider));
      const secrets = secretsCache.get(key);
      result = secrets
        ? await fetchTranscript(ref, secrets)
        : { status: "pending", detail: "The meeting provider is not connected." };
    }

    if (result.status === "ready" && result.segments.length) {
      await db
        .insert(interviewTranscripts)
        .values({
          orgId,
          interviewId: r.id,
          applicationId: r.applicationId,
          provider: ref!.meetingProvider,
          segments: result.segments,
          segmentCount: result.segments.length,
        })
        .onConflictDoNothing();
      await db
        .update(interviews)
        .set({ transcription: "ready", transcriptionDetail: null, transcriptCheckedAt: new Date() })
        .where(where);
      const { emitAgentEvent } = await import("../agents/events");
      await emitAgentEvent({
        orgId,
        type: "interview.transcript_ready",
        subjectType: "application",
        subjectId: r.applicationId,
        actorUserId: null,
        payload: { interviewId: r.id, level: r.level, requisitionId: r.requisitionId },
      });
      ready++;
      continue;
    }
    const detail = result.status === "ready" ? "The transcript came back empty." : result.detail;
    if (result.status === "unavailable" || giveUp) {
      await db
        .update(interviews)
        .set({
          transcription: "unavailable",
          transcriptionDetail:
            result.status === "unavailable"
              ? detail
              : `No transcript arrived within ${TRANSCRIPT_WAIT_HOURS} hours of the call's end (last answer: ${detail})`,
          transcriptCheckedAt: new Date(),
        })
        .where(where);
      continue;
    }
    await db
      .update(interviews)
      .set({
        transcriptionDetail: detail,
        transcriptCheckedAt: new Date(),
        transcriptChecks: sql`${interviews.transcriptChecks} + 1`,
      })
      .where(where);
  }
  return ready;
}
