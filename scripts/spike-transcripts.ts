/**
 * S0 spike (docs/silent-panel-agent-plan.md): can we read a call's transcript
 * back from the organisation's own Zoom / Teams / Meet account?
 *
 * Run against a meeting that has already been held with transcription on:
 *   DATABASE_URL=... bun scripts/spike-transcripts.ts --interview <interviewId>
 *   DATABASE_URL=... bun scripts/spike-transcripts.ts --org <orgId> --link <joinUrl>
 *
 * Prints whether the transcript is ready, pending or unavailable (and why),
 * how many segments and which speakers. The transcript text itself is shown
 * only with --show (first 5 lines, truncated): it is candidate data.
 * Read-only: nothing is written to the database or the provider.
 */
import { and, eq } from "drizzle-orm";

import { interviews, sourceIntegrations } from "../drizzle/schema";
import { db } from "../src/server/db";
import { meetingRefOf } from "../src/lib/meeting-ref";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  let orgId = arg("org");
  let link = arg("link");
  const interviewId = arg("interview");
  if (interviewId) {
    const [r] = await db
      .select({ orgId: interviews.orgId, link: interviews.teamsLink })
      .from(interviews)
      .where(eq(interviews.id, interviewId))
      .limit(1);
    if (!r) throw new Error("No such interview.");
    orgId = r.orgId ?? undefined;
    link = r.link ?? undefined;
  }
  if (!orgId || !link) {
    console.error(
      "usage: bun scripts/spike-transcripts.ts --interview <id> | --org <orgId> --link <joinUrl> [--show]",
    );
    process.exit(2);
  }

  const ref = meetingRefOf(link);
  if (!ref) throw new Error("That link is not a Zoom, Teams or Meet meeting we can read back.");
  console.log(`provider: ${ref.meetingProvider}`);

  const [integration] = await db
    .select({ id: sourceIntegrations.id, enabled: sourceIntegrations.enabled })
    .from(sourceIntegrations)
    .where(
      and(
        eq(sourceIntegrations.orgId, orgId),
        eq(sourceIntegrations.provider, ref.meetingProvider),
      ),
    )
    .limit(1);
  if (!integration) throw new Error(`${ref.meetingProvider} is not set up for this organisation.`);

  const { readSecrets } = await import("../src/lib/integrations.server");
  const { fetchTranscript } = await import("../src/lib/meeting-transcripts.server");
  const result = await fetchTranscript(ref, await readSecrets(integration.id));

  console.log(`status:   ${result.status}`);
  if (result.status !== "ready") {
    console.log(`detail:   ${result.detail}`);
    process.exit(result.status === "unavailable" ? 1 : 0);
  }
  const speakers = new Map<string, number>();
  for (const s of result.segments)
    speakers.set(s.speaker ?? "(unnamed)", (speakers.get(s.speaker ?? "(unnamed)") ?? 0) + 1);
  const last = result.segments[result.segments.length - 1];
  console.log(`segments: ${result.segments.length}, ${Math.round((last?.endMs ?? 0) / 60000)} min`);
  console.log(
    `speakers: ${[...speakers].map(([name, n]) => `${name} (${n})`).join(", ") || "none"}`,
  );
  if (process.argv.includes("--show"))
    for (const s of result.segments.slice(0, 5))
      console.log(`  [${s.speaker ?? "?"}] ${s.text.slice(0, 100)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
