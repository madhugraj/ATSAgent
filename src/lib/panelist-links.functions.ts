/**
 * Public server functions behind /scorecard/<token> — an external panelist's
 * scorecard for one round. No session: the 64-hex token is the only key, every
 * call is rate-limited per caller (src/server.ts covers all server-fn RPCs),
 * and nothing but the round and its rubric is returned.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Token = z.string().regex(/^[a-f0-9]{64}$/, "This link is not valid.");

export const getPanelistScorecard = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ token: Token }).parse(d))
  .handler(async ({ data }) => {
    const { publicScorecard } = await import("./panelist-links.server");
    const card = await publicScorecard(data.token);
    if (!card) throw new Error("This link is not valid.");
    return card;
  });

export const submitPanelistScorecard = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        token: Token,
        rating: z.number().int().min(1).max(5),
        verdict: z.enum(["select", "hold", "reject"]),
        comments: z.string().max(4000).nullable().default(null),
        reason: z.string().max(2000).nullable().default(null),
        competencies: z
          .array(
            z.object({ name: z.string().min(1).max(60), rating: z.number().int().min(1).max(5) }),
          )
          .max(12)
          .default([]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { submitByLink } = await import("./panelist-links.server");
    const { token, ...input } = data;
    return submitByLink(token, input);
  });
