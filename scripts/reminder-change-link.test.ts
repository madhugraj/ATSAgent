/**
 * A panelist's interview reminder links to their own confirmation page, opened
 * on changing the time or length — no sign-in needed. A panelist who was never
 * asked to confirm gets no link, and the reminder never opens a new ask.
 *
 * Run: DATABASE_URL=postgres://…/atsagent_test SESSION_SECRET=… bun test scripts/reminder-change-link.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const { db } = await import("../src/server/db");
const S = await import("../drizzle/schema");
const { sweepInterviewReminders } = await import("../src/lib/interview-reminders.server");
const { renderTemplateEmail } = await import("../src/lib/email-templates/send-email");

const stamp = Date.now();
const SARANYA = `saranya-${stamp}@test.local`;
const OTHER = `other-${stamp}@test.local`;
let orgId: string;
let interviewId: string;

beforeAll(async () => {
  const [o] = await db
    .insert(S.organizations)
    .values({ name: "Reminder Org", slug: `rc-${stamp}`, status: "active" })
    .returning({ id: S.organizations.id });
  orgId = o!.id;
  const [u] = await db
    .insert(S.users)
    .values({ email: `hm-${stamp}@test.local` })
    .returning({ id: S.users.id });
  const [req] = await db
    .insert(S.requisitions)
    .values({
      orgId,
      code: `RC-${stamp}`,
      title: "AI Intern",
      status: "approved",
      createdBy: u!.id,
    } as never)
    .returning({ id: S.requisitions.id });
  const [c] = await db
    .insert(S.candidates)
    .values({ orgId, fullName: "Vishal", email: `v-${stamp}@cand.local` } as never)
    .returning({ id: S.candidates.id });
  const [a] = await db
    .insert(S.applications)
    .values({ orgId, requisitionId: req!.id, candidateId: c!.id, stage: "l3" } as never)
    .returning({ id: S.applications.id });
  const at = new Date(Date.now() + 20 * 3600_000);
  const [iv] = await db
    .insert(S.interviews)
    .values({
      orgId,
      applicationId: a!.id,
      level: 3,
      interviewer: "Saranya",
      interviewerEmail: SARANYA,
      panel: [{ email: OTHER, name: "Other" }],
      scheduledAt: at,
      status: "scheduled",
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    } as never)
    .returning({ id: S.interviews.id });
  interviewId = iv!.id;
  await db.insert(S.interviewConfirmations).values({
    orgId,
    interviewId,
    party: "panelist",
    email: SARANYA,
    name: "Saranya",
    token: `tok-${stamp}`,
    state: "accepted",
    scheduledAt: at,
  } as never);
});

afterAll(async () => {
  await db.delete(S.organizations).where(eq(S.organizations.id, orgId));
});

test("the panel reminder links to the panelist's own change page", async () => {
  await sweepInterviewReminders(orgId);
  const mails = await db
    .select({ to: S.emailOutbox.toEmail, data: S.emailOutbox.templateData })
    .from(S.emailOutbox)
    .where(and(eq(S.emailOutbox.orgId, orgId), eq(S.emailOutbox.kind, "interviewer_reminder")));
  const by = Object.fromEntries(mails.map((m) => [m.to, m.data as Record<string, string>]));
  expect(by[SARANYA]!.changeUrl).toMatch(new RegExp(`/confirm/tok-${stamp}\\?change=1$`));
  expect(by[OTHER]!.changeUrl).toBeUndefined();
  // No new confirmation was opened for the panelist who was never asked.
  const rows = await db
    .select({ email: S.interviewConfirmations.email })
    .from(S.interviewConfirmations)
    .where(eq(S.interviewConfirmations.interviewId, interviewId));
  expect(rows.map((r) => r.email)).toEqual([SARANYA]);
  const { html } = await renderTemplateEmail("interview_reminder", by[SARANYA]!);
  expect(html).toContain("Change the time or length");
  expect(html).toContain(`/confirm/tok-${stamp}?change=1`);
});
