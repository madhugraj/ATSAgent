/**
 * Meeting-link providers.
 *
 * Every credential here belongs to the HR/admin user and is stored by them on
 * the Integrations page (public.integration_credentials, service-role only).
 * Nothing is taken from the builder's own accounts.
 */

import { env } from "../server/env";

export type MeetingProviderId = "zoom" | "google_meet" | "teams";

export type MeetingRequest = {
  topic: string;
  startIso: string;
  durationMins: number;
  attendees: string[];
  agenda?: string | null;
};

export type MeetingResult = {
  joinUrl: string;
  externalId: string | null;
  provider: MeetingProviderId;
};

const FIELD_LABEL: Record<string, string> = {
  tenant_id: "Directory (tenant) ID",
  client_id: "Application (client) ID",
  client_secret: "Client secret value",
  organizer_email: "Organizer mailbox",
  account_id: "Account ID",
  refresh_token: "Refresh token",
};

function need(secrets: Record<string, string>, keys: string[], label: string) {
  const missing = keys.filter((k) => !secrets[k]);
  if (missing.length)
    throw new Error(
      `${label} is not fully configured — save ${missing
        .map((k) => FIELD_LABEL[k] ?? k)
        .join(", ")} on the Integrations page, then test again.`,
    );
}

async function jsonOrThrow(res: Response, label: string) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed [${res.status}]: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned a non-JSON response.`);
  }
}

/* ------------------------------------------------------------------- Zoom */

async function zoomToken(s: Record<string, string>) {
  // Delegated user OAuth (Connect button): refresh the user's token instead of S2S.
  if (s["refresh_token"]) {
    const basic = Buffer.from(
      `${env.ZOOM_OAUTH_CLIENT_ID ?? ""}:${env.ZOOM_OAUTH_CLIENT_SECRET ?? ""}`,
    ).toString("base64");
    const res = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: s["refresh_token"]!,
      }),
    });
    const body = await jsonOrThrow(res, "Zoom token refresh");
    return String(body["access_token"] ?? "");
  }
  need(s, ["account_id", "client_id", "client_secret"], "Zoom");
  const basic = Buffer.from(`${s["client_id"]}:${s["client_secret"]}`).toString("base64");
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(s["account_id"]!)}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
  );
  const body = await jsonOrThrow(res, "Zoom token request");
  return String(body["access_token"] ?? "");
}

async function zoomMeeting(s: Record<string, string>, req: MeetingRequest): Promise<MeetingResult> {
  const token = await zoomToken(s);
  const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: req.topic,
      type: 2,
      start_time: new Date(req.startIso).toISOString(),
      duration: req.durationMins,
      agenda: req.agenda ?? undefined,
      settings: { join_before_host: true, waiting_room: false },
    }),
  });
  const body = await jsonOrThrow(res, "Zoom meeting creation");
  return {
    joinUrl: String(body["join_url"] ?? ""),
    externalId: String(body["id"] ?? "") || null,
    provider: "zoom",
  };
}

/* ---------------------------------------------------------- Google / Meet */

export async function googleToken(s: Record<string, string>) {
  const clientId =
    s["client_id"] ?? env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID ?? env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret =
    s["client_secret"] ?? env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret || !s["refresh_token"])
    throw new Error(
      "Google Calendar is not fully configured (missing client id, secret or refresh token).",
    );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: s["refresh_token"]!,
    }),
  });
  const body = await jsonOrThrow(res, "Google token refresh");
  return String(body["access_token"] ?? "");
}

/**
 * Turn Google's raw calendar-API error JSON into guidance an HR user can act
 * on. The two failure modes that reach production: the connected account has
 * no Calendar service at all (Workspace admin disabled it), or the consent
 * grant predates the Calendar scope.
 */
async function googleCalendarError(e: unknown): Promise<Error> {
  const msg = (e as Error).message;
  if (msg.includes("notACalendarUser"))
    return new Error(
      "Google Calendar is not available on the connected account — Google refused to create the event. " +
        "Ask your Google Workspace admin to enable the Calendar service for that user, or connect a different " +
        "account on the Integrations page.",
    );
  if (msg.includes("insufficientPermissions") || msg.includes("insufficient authentication scopes"))
    return new Error(
      "The connected Google account did not grant Calendar access — disconnect Google Meet on the " +
        "Integrations page and connect it again, keeping the Calendar permission ticked.",
    );
  return e instanceof Error ? e : new Error(msg);
}

async function googleMeeting(
  s: Record<string, string>,
  req: MeetingRequest,
): Promise<MeetingResult> {
  const token = await googleToken(s);
  const start = new Date(req.startIso);
  const end = new Date(start.getTime() + req.durationMins * 60_000);
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: req.topic,
        description: req.agenda ?? undefined,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: req.attendees.filter(Boolean).map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    },
  );
  let body: Record<string, unknown>;
  try {
    body = await jsonOrThrow(res, "Google Calendar event creation");
  } catch (e) {
    throw await googleCalendarError(e);
  }
  const conf = body["conferenceData"] as { entryPoints?: { uri?: string }[] } | undefined;
  const joinUrl =
    (typeof body["hangoutLink"] === "string" ? body["hangoutLink"] : "") ||
    conf?.entryPoints?.find((e) => typeof e.uri === "string")?.uri ||
    "";
  return {
    joinUrl,
    externalId: (body["id"] as string | undefined) ?? null,
    provider: "google_meet",
  };
}

/* ------------------------------------------------------------------ Teams */

export async function graphToken(s: Record<string, string>) {
  need(s, ["tenant_id", "client_id", "client_secret", "organizer_email"], "Microsoft Teams");
  const res = await fetch(`https://login.microsoftonline.com/${s["tenant_id"]}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: s["client_id"]!,
      client_secret: s["client_secret"]!,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const body = await jsonOrThrow(res, "Microsoft token request");
  return String(body["access_token"] ?? "");
}

const TEAMS_PERMISSION_HELP =
  "Microsoft rejected the request (403 Forbidden). Ask your Microsoft 365 admin to grant the app registration " +
  "the application permissions OnlineMeetings.ReadWrite.All and Calendars.ReadWrite (with admin consent), and to " +
  "run an application access policy (New-CsApplicationAccessPolicy / Grant-CsApplicationAccessPolicy) for the " +
  "organizer mailbox so the app may create meetings on their behalf.";

export async function msDelegatedToken(s: Record<string, string>): Promise<string> {
  const tenant = s["tenant_id"] || "organizations";
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID ?? "",
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET ?? "",
      refresh_token: s["refresh_token"]!,
      scope: "https://graph.microsoft.com/.default offline_access",
    }),
  });
  const body = await jsonOrThrow(res, "Microsoft token refresh");
  return String(body["access_token"] ?? "");
}

async function teamsMeeting(
  s: Record<string, string>,
  req: MeetingRequest,
): Promise<MeetingResult> {
  // Delegated consent tokens mint the meeting as the connected HR user via /me —
  // no application-permission access policy involved.
  if (s["refresh_token"]) {
    const token = await msDelegatedToken(s);
    const start = new Date(req.startIso);
    const end = new Date(start.getTime() + req.durationMins * 60_000);
    const res = await fetch("https://graph.microsoft.com/v1.0/me/onlineMeetings", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: req.topic,
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Teams meeting creation failed [${res.status}]: ${detail}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      joinUrl: String(body["joinWebUrl"] ?? ""),
      externalId: (body["id"] as string | undefined) ?? null,
      provider: "teams",
    };
  }
  const token = await graphToken(s);
  const start = new Date(req.startIso);
  const end = new Date(start.getTime() + req.durationMins * 60_000);
  const user = encodeURIComponent(s["organizer_email"]!);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Preferred: dedicated online meeting (needs OnlineMeetings.ReadWrite.All + access policy).
  const direct = await fetch(`https://graph.microsoft.com/v1.0/users/${user}/onlineMeetings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      subject: req.topic,
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
    }),
  });

  if (direct.ok) {
    const body = (await direct.json()) as Record<string, unknown>;
    return {
      joinUrl: String(body["joinWebUrl"] ?? ""),
      externalId: (body["id"] as string | undefined) ?? null,
      provider: "teams",
    };
  }

  if (direct.status !== 403 && direct.status !== 401) {
    await jsonOrThrow(direct, "Teams meeting creation");
  }

  // Fallback: calendar event with a Teams link (needs Calendars.ReadWrite only).
  const evt = await fetch(`https://graph.microsoft.com/v1.0/users/${user}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      subject: req.topic,
      body: req.agenda ? { contentType: "text", content: req.agenda } : undefined,
      start: { dateTime: start.toISOString(), timeZone: "UTC" },
      end: { dateTime: end.toISOString(), timeZone: "UTC" },
      attendees: req.attendees.filter(Boolean).map((email) => ({
        emailAddress: { address: email },
        type: "required",
      })),
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
    }),
  });

  if (!evt.ok) {
    const detail = (await evt.text()).slice(0, 300);
    throw new Error(`${TEAMS_PERMISSION_HELP} (Graph said: ${evt.status} ${detail})`);
  }

  const body = (await evt.json()) as Record<string, unknown>;
  const meeting = body["onlineMeeting"] as { joinUrl?: string } | undefined;
  return {
    joinUrl: String(meeting?.joinUrl ?? ""),
    externalId: (body["id"] as string | undefined) ?? null,
    provider: "teams",
  };
}

/* --------------------------------------------------------------- dispatch */

export async function createMeeting(
  provider: MeetingProviderId,
  secrets: Record<string, string>,
  req: MeetingRequest,
): Promise<MeetingResult> {
  const result =
    provider === "zoom"
      ? await zoomMeeting(secrets, req)
      : provider === "google_meet"
        ? await googleMeeting(secrets, req)
        : await teamsMeeting(secrets, req);
  if (!result.joinUrl) throw new Error(`${provider} did not return a join link.`);
  return result;
}

/** Credential check used by the Integrations "Test" button. */
export async function testMeetingProvider(
  provider: MeetingProviderId,
  secrets: Record<string, string>,
) {
  try {
    if (provider === "zoom") {
      await zoomToken(secrets);
      return { status: "ok" as const, message: "Zoom server-to-server credentials accepted." };
    }
    if (provider === "google_meet") {
      const token = await googleToken(secrets);
      // A valid token is not enough — the account itself must have the
      // Calendar service (403 notACalendarUser otherwise), so probe it here
      // where the admin is watching, not later at scheduling time.
      const probe = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!probe.ok) {
        const detail = await probe.text().catch(() => "");
        throw await googleCalendarError(
          new Error(`Google Calendar probe failed [${probe.status}]: ${detail.slice(0, 300)}`),
        );
      }
      return {
        status: "ok" as const,
        message: "Google Calendar is reachable — Meet links can be created.",
      };
    }
    await graphToken(secrets);
    return { status: "ok" as const, message: "Microsoft Graph credentials accepted." };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      status: msg.includes("not fully configured") ? ("pending" as const) : ("failed" as const),
      message: msg,
    };
  }
}
