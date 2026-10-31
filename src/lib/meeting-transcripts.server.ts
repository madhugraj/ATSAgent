/**
 * Read a round's transcript back from the meeting provider after the call
 * (docs/silent-panel-agent-plan.md, S0). Read-only: nothing here changes a
 * meeting. The credentials are the organisation's own (Integrations page),
 * the same ones the meeting was created with.
 *
 * What each provider needs (verified in the S0 spike, scripts/spike-transcripts.ts):
 *   - Zoom: cloud recording with audio transcripts on the account; scope to
 *     read cloud recordings.
 *   - Teams: transcription allowed by the tenant's meeting policy; Graph
 *     permission OnlineMeetingTranscript.Read.All (delegated, or application
 *     with an application access policy for the organiser).
 *   - Meet: a Workspace edition with transcripts; the Google grant needs the
 *     meetings.space.readonly scope.
 *
 * Transcripts are candidate data: callers store them org-scoped and tied to
 * the application so erasure removes them, and they enter AI prompts only
 * through `untrusted(...)`.
 */
import { safeFetchText } from "../server/safe-fetch";
import { googleToken, graphToken, msDelegatedToken, zoomToken } from "./meetings.server";
import type { MeetingRef } from "./meeting-ref";
import { parseVtt, type TranscriptSegment } from "./vtt";

export type { TranscriptSegment };

export type TranscriptFetch =
  | { status: "ready"; segments: TranscriptSegment[] }
  /** Not there yet: the call has not ended, or the provider is still processing it. */
  | { status: "pending"; detail: string }
  /** It will not come: no permission, transcription off, or the meeting is gone. */
  | { status: "unavailable"; detail: string };

const MAX_TRANSCRIPT_BYTES = 5_000_000;
const MAX_SEGMENTS = 5_000;

/* -------------------------------------------------------------------- Zoom */

async function zoomTranscript(
  s: Record<string, string>,
  meetingId: string,
): Promise<TranscriptFetch> {
  const token = await zoomToken(s);
  const res = await fetch(
    `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/recordings`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404)
    return { status: "pending", detail: "Zoom has no cloud recording for this meeting yet." };
  if (res.status === 401 || res.status === 403)
    return {
      status: "unavailable",
      detail: `Zoom refused to share the recording (${res.status}) — the app needs permission to read cloud recordings.`,
    };
  if (!res.ok) return { status: "pending", detail: `Zoom recordings returned ${res.status}.` };
  const body = (await res.json()) as {
    recording_files?: { file_type?: string; status?: string; download_url?: string }[];
  };
  const files = body.recording_files ?? [];
  const file = files.find((f) => f.file_type === "TRANSCRIPT");
  if (!file)
    return files.length
      ? {
          status: "unavailable",
          detail:
            "The meeting was recorded but Zoom made no transcript — turn on audio transcripts for cloud recordings in the Zoom account settings.",
        }
      : { status: "pending", detail: "Zoom is still processing the recording." };
  if (file.status && file.status !== "completed")
    return { status: "pending", detail: "Zoom is still writing the transcript." };
  const url = new URL(file.download_url ?? "");
  if (!/(^|\.)zoom(gov)?\.(us|com)$/.test(url.hostname))
    return { status: "unavailable", detail: "Zoom returned an unexpected download address." };
  const { text } = await safeFetchText(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    hops: 3,
    maxBytes: MAX_TRANSCRIPT_BYTES,
    timeoutMs: 30_000,
  });
  return { status: "ready", segments: parseVtt(text) };
}

/* ------------------------------------------------------------------- Teams */

async function teamsTranscript(
  s: Record<string, string>,
  joinUrl: string,
): Promise<TranscriptFetch> {
  const delegated = Boolean(s["refresh_token"]);
  const token = delegated ? await msDelegatedToken(s) : await graphToken(s);
  const base = delegated
    ? "https://graph.microsoft.com/v1.0/me"
    : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(s["organizer_email"] ?? "")}`;
  const headers = { Authorization: `Bearer ${token}` };
  const denied = (status: number) => ({
    status: "unavailable" as const,
    detail: `Microsoft refused to share the transcript (${status}) — grant OnlineMeetingTranscript.Read.All${delegated ? "" : " with an application access policy for the organiser"}.`,
  });

  const filter = `JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`;
  const found = await fetch(`${base}/onlineMeetings?$filter=${encodeURIComponent(filter)}`, {
    headers,
  });
  if (found.status === 401 || found.status === 403) return denied(found.status);
  if (!found.ok)
    return { status: "pending", detail: `Teams meeting lookup returned ${found.status}.` };
  const meetingId = ((await found.json()) as { value?: { id?: string }[] }).value?.[0]?.id;
  if (!meetingId)
    return {
      status: "unavailable",
      detail: "Teams has no online meeting with this link under the connected account.",
    };

  const list = await fetch(`${base}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`, {
    headers,
  });
  if (list.status === 401 || list.status === 403) return denied(list.status);
  if (!list.ok) return { status: "pending", detail: `Teams transcripts returned ${list.status}.` };
  const transcripts =
    ((await list.json()) as { value?: { id?: string; createdDateTime?: string }[] }).value ?? [];
  // The latest transcript of the meeting (a restarted transcription makes several).
  const latest = transcripts
    .filter((t) => t.id)
    .sort((a, b) => (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""))
    .pop();
  if (!latest)
    return { status: "pending", detail: "Teams has no transcript for this meeting yet." };

  const content = await fetch(
    `${base}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(latest.id!)}/content?$format=text/vtt`,
    { headers },
  );
  if (content.status === 401 || content.status === 403) return denied(content.status);
  if (!content.ok)
    return { status: "pending", detail: `Teams transcript content returned ${content.status}.` };
  const text = await content.text();
  if (text.length > MAX_TRANSCRIPT_BYTES)
    return { status: "unavailable", detail: "The Teams transcript is too large to read." };
  return { status: "ready", segments: parseVtt(text) };
}

/* -------------------------------------------------------------------- Meet */

const MEET_API = "https://meet.googleapis.com/v2";

async function meetTranscript(s: Record<string, string>, code: string): Promise<TranscriptFetch> {
  const token = await googleToken(s);
  const headers = { Authorization: `Bearer ${token}` };
  const denied = (status: number) => ({
    status: "unavailable" as const,
    detail: `Google refused to share the transcript (${status}) — reconnect Google Meet on the Integrations page so the grant includes reading Meet transcripts.`,
  });
  const get = async (path: string) => {
    const res = await fetch(`${MEET_API}/${path}`, { headers });
    return { res, body: res.ok ? ((await res.json()) as Record<string, unknown>) : null };
  };

  const records = await get(
    `conferenceRecords?filter=${encodeURIComponent(`space.meeting_code = "${code}"`)}`,
  );
  if (records.res.status === 401 || records.res.status === 403) return denied(records.res.status);
  if (!records.body)
    return { status: "pending", detail: `Meet conference records returned ${records.res.status}.` };
  const record = (
    (records.body["conferenceRecords"] ?? []) as { name?: string; startTime?: string }[]
  )
    .filter((r) => r.name)
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""))
    .pop();
  if (!record) return { status: "pending", detail: "Nobody has held this Meet call yet." };

  const list = await get(`${record.name}/transcripts`);
  if (list.res.status === 401 || list.res.status === 403) return denied(list.res.status);
  if (!list.body)
    return { status: "pending", detail: `Meet transcripts returned ${list.res.status}.` };
  const transcript = ((list.body["transcripts"] ?? []) as { name?: string; state?: string }[]).find(
    (t) => t.name,
  );
  if (!transcript)
    return { status: "pending", detail: "Meet has no transcript for this call yet." };
  if (transcript.state !== "FILE_GENERATED" && transcript.state !== "ENDED")
    return { status: "pending", detail: "Meet is still writing the transcript." };

  type Entry = { participant?: string; text?: string; startTime?: string; endTime?: string };
  const entries: Entry[] = [];
  let pageToken = "";
  do {
    const page = await get(
      `${transcript.name}/entries?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    if (!page.body)
      return { status: "pending", detail: `Meet transcript entries returned ${page.res.status}.` };
    entries.push(...((page.body["transcriptEntries"] ?? []) as Entry[]));
    pageToken = String(page.body["nextPageToken"] ?? "");
  } while (pageToken && entries.length < MAX_SEGMENTS);

  const names = new Map<string, string | null>();
  for (const p of new Set(entries.map((e) => e.participant).filter(Boolean) as string[])) {
    const { body } = await get(p);
    const who = (body?.["signedinUser"] ?? body?.["anonymousUser"] ?? body?.["phoneUser"]) as
      { displayName?: string } | undefined;
    names.set(p, who?.displayName ?? null);
  }
  const t0 = entries.length ? Date.parse(entries[0]!.startTime ?? "") : 0;
  const rel = (t?: string) => Math.max(0, (Date.parse(t ?? "") || t0) - t0);
  return {
    status: "ready",
    segments: entries
      .filter((e) => e.text?.trim())
      .map((e) => ({
        speaker: e.participant ? (names.get(e.participant) ?? null) : null,
        text: e.text!.trim(),
        startMs: rel(e.startTime),
        endMs: rel(e.endTime),
      })),
  };
}

/* ----------------------------------------------------------------- dispatch */

export async function fetchTranscript(
  ref: MeetingRef,
  secrets: Record<string, string>,
): Promise<TranscriptFetch> {
  try {
    if (ref.meetingProvider === "zoom") return await zoomTranscript(secrets, ref.meetingExternalId);
    if (ref.meetingProvider === "teams")
      return await teamsTranscript(secrets, ref.meetingExternalId);
    return await meetTranscript(secrets, ref.meetingExternalId);
  } catch (e) {
    // Token refresh and network failures: try again later.
    return { status: "pending", detail: (e as Error).message.slice(0, 300) };
  }
}
