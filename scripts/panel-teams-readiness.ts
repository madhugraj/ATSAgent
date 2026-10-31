/**
 * Is an organisation ready for a real Teams test of the silent panel agents?
 * (docs/runbooks/silent-panel-teams-test.md). Read-only: it checks each thing
 * the test needs, in order, and says what to do for anything missing. The
 * Teams check refreshes the connection's token and reads which permissions
 * Microsoft actually granted — no meeting is touched, nothing is printed
 * that is secret.
 *
 *   bun --env-file=.env.local scripts/panel-teams-readiness.ts <organisation id> [level]
 */
import { and, eq, inArray } from "drizzle-orm";

import {
  agentPolicies,
  agentRuntimeHeartbeat,
  aiSettings,
  panelAgentSettings,
  sourceIntegrations,
} from "../drizzle/schema";
import { db } from "../src/server/db";

const orgId = process.argv[2];
const level = Number(process.argv[3] ?? 1);
if (!orgId || ![1, 2, 3].includes(level)) {
  console.error(
    "usage: bun --env-file=.env.local scripts/panel-teams-readiness.ts <orgId> [level 1-3]",
  );
  process.exit(2);
}

type Row = { step: string; ready: "yes" | "NO" | "check"; detail: string };
const rows: Row[] = [];
const add = (step: string, ready: Row["ready"], detail: string) =>
  rows.push({ step, ready, detail });

// 1. The platform's Microsoft app (the "Connect" button's sign-in).
const { oauthConfigured } = await import("../src/lib/meetings-oauth.server");
add(
  "Microsoft sign-in app configured on this server",
  oauthConfigured("microsoft") ? "yes" : "NO",
  oauthConfigured("microsoft")
    ? "MICROSOFT_OAUTH_CLIENT_ID / _SECRET are set"
    : "Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET (the platform's Entra app).",
);

// 2. The organisation's switch and rounds.
const [panel] = await db
  .select()
  .from(panelAgentSettings)
  .where(eq(panelAgentSettings.orgId, orgId))
  .limit(1);
add(
  `Silent panel agent on, for L${level}`,
  panel?.enabled && panel.levels.includes(level) ? "yes" : "NO",
  panel?.enabled && panel.levels.includes(level)
    ? `on for ${panel.levels.map((l) => `L${l}`).join(", ")}`
    : `Organisation → Silent panel agent: switch it on with L${level} ticked, and save — BEFORE reconnecting Teams (step 4).`,
);

// 3. The level's agent.
const all = await db
  .select()
  .from(agentPolicies)
  .where(
    and(
      eq(agentPolicies.orgId, orgId),
      inArray(agentPolicies.agentType, ["*", `panel_l${level}`] as never),
    ),
  );
const own = all.find((p) => p.agentType === `panel_l${level}`);
const paused = all.find((p) => p.agentType === "*")?.enabled === false;
add(
  `L${level} panel agent switched on`,
  own?.enabled && !paused ? "yes" : "NO",
  paused
    ? "All agents are paused (Agent settings → Pause all agents)."
    : own?.enabled
      ? `on · ${own.autonomy.replace(/_/g, " ")}`
      : `Agent settings → L${level} panel agent: switch it on.`,
);
add(
  `L${level} agent can act without a click per step`,
  own?.enabled && own.autonomy !== "suggest" && own.whitelistedTemplates.includes("panel_summary")
    ? "yes"
    : "check",
  own?.autonomy === "suggest"
    ? "Autonomy is Suggest: each assessment and summary waits for your approval (fine, just slower). For the test, Act and notify + tick “Interview call summary (to the panel)”."
    : own?.whitelistedTemplates.includes("panel_summary")
      ? "act and notify, summary pre-approved"
      : "Tick “Interview call summary (to the panel)” or each summary e-mail waits for approval.",
);

// 4. Teams: connected, switched on, and what Microsoft actually granted.
const [teams] = await db
  .select()
  .from(sourceIntegrations)
  .where(and(eq(sourceIntegrations.orgId, orgId), eq(sourceIntegrations.provider, "teams")))
  .limit(1);
if (!teams?.hasCredentials) {
  add("Teams connected", "NO", "Integrations → Microsoft Teams → Connect.");
} else {
  add(
    "Teams switched on",
    teams.enabled ? "yes" : "NO",
    teams.enabled
      ? "on"
      : "Integrations → Microsoft Teams: switch it on (it is connected but off).",
  );
  const { readSecrets } = await import("../src/lib/integrations.server");
  const s = await readSecrets(teams.id);
  if (!s["refresh_token"]) {
    add(
      "Teams connected by signing in",
      "check",
      "Connected with app credentials, not by signing in: the app needs the application permission OnlineMeetingTranscript.Read.All and an application access policy for the organiser.",
    );
  } else {
    try {
      const { msDelegatedToken } = await import("../src/lib/meetings.server");
      const token = await msDelegatedToken(s);
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
        scp?: string;
        upn?: string;
        preferred_username?: string;
      };
      const scp = (claims.scp ?? "").split(" ");
      add(
        "Teams connection alive (token refreshes)",
        "yes",
        `connected as ${claims.upn ?? claims.preferred_username ?? "the HR user"}`,
      );
      add(
        "Teams can create meetings",
        scp.includes("OnlineMeetings.ReadWrite") ? "yes" : "NO",
        scp.includes("OnlineMeetings.ReadWrite")
          ? "OnlineMeetings.ReadWrite granted"
          : "Reconnect Teams.",
      );
      add(
        "Teams can read transcripts",
        scp.includes("OnlineMeetingTranscript.Read.All") ? "yes" : "NO",
        scp.includes("OnlineMeetingTranscript.Read.All")
          ? "OnlineMeetingTranscript.Read.All granted"
          : "1) Entra admin: add the delegated permission OnlineMeetingTranscript.Read.All to the platform's app and grant admin consent. 2) With the silent panel agent ON, Integrations → Teams: disconnect, connect again.",
      );
    } catch (e) {
      add(
        "Teams connection alive (token refreshes)",
        "NO",
        `${(e as Error).message.slice(0, 160)} — reconnect Teams.`,
      );
    }
  }
}
add(
  "Teams meeting policy allows transcription",
  "check",
  "Not visible from here: Teams admin centre → Meetings → Meeting policies → Recording & transcription → Transcription on (for the organiser).",
);

// 5. The AI model the agent assesses with.
const [ai] = await db.select().from(aiSettings).where(eq(aiSettings.orgId, orgId)).limit(1);
add(
  "AI model for the assessment",
  ai ? "yes" : "NO",
  ai ? "set (Integrations → AI model)" : "Integrations → AI model: save the organisation's key.",
);

// 6. The scheduler that fetches transcripts and runs agents.
const [beat] = await db.select().from(agentRuntimeHeartbeat).limit(1);
const age = beat?.lastTickAt ? Math.round((Date.now() - beat.lastTickAt.getTime()) / 1000) : null;
add(
  "Scheduler ticking (fetches transcripts, runs agents)",
  age != null && age < 120 ? "check" : "NO",
  age == null
    ? "Never ticked: run bun --env-file=.env.local scripts/dev-agent-tick.ts from the folder port 9000 runs."
    : `last tick ${age}s ago — make sure it runs the same code as port 9000 (restart it after switching branches).`,
);

// 7. E-mail, for the panel's summary.
add(
  "E-mail can be sent (panel summary)",
  process.env["SMTP_URL"] ? "yes" : "check",
  process.env["SMTP_URL"]
    ? "SMTP configured"
    : "No SMTP_URL: summaries queue but are not delivered.",
);

console.log(`\nSilent panel agents — Teams test readiness (L${level})\n`);
console.table(rows);
const missing = rows.filter((r) => r.ready === "NO").length;
console.log(
  missing
    ? `\n${missing} thing(s) to do before the test.`
    : "\nReady, apart from the items marked check.",
);
process.exit(0);
