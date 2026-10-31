/**
 * Which provider a meeting link belongs to, and the reference its API needs to
 * find the meeting again after the call (docs/silent-panel-agent-plan.md, S0):
 *
 *   - Zoom: the numeric meeting id (`/j/<id>`, `/w/<id>`, `/s/<id>`).
 *   - Google Meet: the meeting code (`abc-defg-hij`); Meet's API finds the
 *     conference records by it.
 *   - Teams: the join link itself; Graph finds the online meeting by it
 *     (`JoinWebUrl eq '…'`), whether it was made as an online meeting or as
 *     a calendar event.
 *
 * Read from the link server-side, so every way a round is booked (the
 * candidate's pick, the coordinator, the Interviews page, a pasted link)
 * records it the same way and nothing is taken from the client. Keep in step
 * with the backfill in drizzle/pg-migrations/0059_meeting_ref.sql.
 */
export type MeetingRef = {
  meetingProvider: "zoom" | "google_meet" | "teams";
  meetingExternalId: string;
};

export function meetingRefOf(link: string | null | undefined): MeetingRef | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (/(^|\.)zoom(gov)?\.(us|com)$/.test(host)) {
    const id = /^\/(?:j|w|s)\/(\d{9,12})(?:\/|$)/.exec(url.pathname)?.[1];
    return id ? { meetingProvider: "zoom", meetingExternalId: id } : null;
  }
  if (host === "meet.google.com") {
    const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/.exec(url.pathname.toLowerCase())?.[1];
    return code ? { meetingProvider: "google_meet", meetingExternalId: code } : null;
  }
  if (host === "teams.microsoft.com" || host === "teams.live.com") {
    return /^\/(l\/meetup-join|meet)\//.test(url.pathname)
      ? { meetingProvider: "teams", meetingExternalId: link.trim() }
      : null;
  }
  return null;
}
