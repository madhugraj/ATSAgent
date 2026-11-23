/**
 * Public server functions behind /confirm/<token> — a panelist's or candidate's
 * answer to an interview time. No session: the 64-hex token is the only key,
 * every call is rate-limited per caller (src/server.ts covers all server-fn
 * RPCs), and only the round's own details come back. The hiring team's
 * "send the invite now" is behind requireOrg, like booking itself.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireOrg } from "./auth.middleware";

const Token = z.string().regex(/^[a-f0-9]{64}$/, "This link is not valid.");

export const getConfirmation = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ token: Token }).parse(d))
  .handler(async ({ data }) => {
    const { publicConfirmation } = await import("./interview-confirmations.server");
    const c = await publicConfirmation(data.token);
    if (!c) throw new Error("This link is not valid.");
    return c;
  });

export const answerTime = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        token: Token,
        accept: z.boolean(),
        note: z.string().max(500).default(""),
        /** Offers: the times (ISO) that work; absent = all of them. */
        okSlots: z
          .array(z.string().datetime({ offset: true }))
          .max(5)
          .optional(),
        suggestedAt: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { answerConfirmation } = await import("./interview-confirmations.server");
    return answerConfirmation(data.token, {
      accept: data.accept,
      note: data.note,
      ...(data.okSlots ? { okSlots: data.okSlots } : {}),
      suggestedAt: data.suggestedAt ?? null,
    });
  });

export const sendInviteNow = createServerFn({ method: "POST" })
  .middleware([requireOrg])
  .validator((d: unknown) => z.object({ interviewId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { releaseInviteNow } = await import("./interview-confirmations.server");
    const n = await releaseInviteNow(context.orgId, data.interviewId, {
      email: context.memberEmail,
      userId: context.userId,
    });
    return { sent: n > 0 };
  });

export const roundConfirmations = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z.object({ interviewIds: z.array(z.string().uuid()).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { confirmationsFor } = await import("./interview-confirmations.server");
    return confirmationsFor(context.orgId, data.interviewIds);
  });

/** Interviewers whose scorecard is past due (2 h after the round), by round id. */
export const overdueScorecards = createServerFn({ method: "GET" })
  .middleware([requireOrg])
  .validator((d: unknown) =>
    z.object({ interviewIds: z.array(z.string().uuid()).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!data.interviewIds.length) return {} as Record<string, string[]>;
    const { db } = await import("../server/db");
    const { interviews } = await import("@db/schema");
    const { and, eq, inArray, sql } = await import("drizzle-orm");
    const { missingScorecards, SCORECARD_DUE } = await import("./scorecard-chase.server");
    const due = await db
      .select({ id: interviews.id })
      .from(interviews)
      .where(
        and(
          eq(interviews.orgId, context.orgId),
          inArray(interviews.id, data.interviewIds),
          inArray(interviews.status, ["scheduled", "rescheduled", "completed"]),
          sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.durationMins} + ${SCORECARD_DUE.dueHours * 60}) <= now()`,
        ),
      );
    return missingScorecards(
      context.orgId,
      due.map((d) => d.id),
    );
  });

/* Panel liberty (src/lib/panel-changes.server.ts): public, token-keyed. */

export const getChangeOptions = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z.object({ token: Token, durationMins: z.number().int().min(15).max(240).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { changeOptions } = await import("./panel-changes.server");
    return changeOptions(data.token, Date.now(), data.durationMins);
  });

export const changeInterviewTime = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        token: Token,
        reason: z.string().max(500),
        to: z.string().datetime({ offset: true }).nullable(),
        durationMins: z.number().int().min(15).max(240).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { changeTime } = await import("./panel-changes.server");
    return changeTime(data.token, {
      reason: data.reason,
      to: data.to,
      durationMins: data.durationMins,
    });
  });

export const getRoundScorecard = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ token: Token }).parse(d))
  .handler(async ({ data }) => {
    const { publicRound } = await import("./panel-changes.server");
    return publicRound(data.token);
  });

export const proposeScorecardChange = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ token: Token, change: z.unknown() }).parse(d))
  .handler(async ({ data }) => {
    const { proposePlanChange } = await import("./panel-changes.server");
    return proposePlanChange(data.token, data.change);
  });
