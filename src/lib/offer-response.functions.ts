/**
 * Public server functions behind /offer/<token> — the candidate's answer to a
 * released offer. No session: the 64-hex token is the only key; every call is
 * rate-limited with all other RPCs (src/server.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Token = z.string().regex(/^[a-f0-9]{64}$/, "This link is not valid.");

export const getOfferForResponse = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ token: Token }).parse(d))
  .handler(async ({ data }) => {
    const { publicOfferView } = await import("./offer-response.server");
    const v = await publicOfferView(data.token);
    if (!v) throw new Error("This link is not valid.");
    return v;
  });

const Answer = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("decline"), reason: z.string().trim().min(3).max(500) }),
  z.object({
    action: z.literal("ask_changes"),
    expectedCtc: z.number().positive().max(1e10).nullable(),
    joiningDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    note: z.string().max(1000).default(""),
  }),
]);

export const respondToOfferLink = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ token: Token, answer: Answer }).parse(d))
  .handler(async ({ data }) => {
    const { respondToOffer } = await import("./offer-response.server");
    return respondToOffer(data.token, data.answer);
  });
