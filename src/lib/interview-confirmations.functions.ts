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
    z.object({ token: Token, accept: z.boolean(), note: z.string().max(500).default("") }).parse(d),
  )
  .handler(async ({ data }) => {
    const { answerConfirmation } = await import("./interview-confirmations.server");
    return answerConfirmation(data.token, data.accept, data.note);
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
