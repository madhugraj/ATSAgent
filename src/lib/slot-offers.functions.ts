/**
 * Public server functions behind /schedule/<token> — the candidate's own
 * interview-time page. No session: the 64-hex token is the only key, every
 * call is rate-limited per caller (src/server.ts covers all server-fn RPCs),
 * and nothing but the offer's own round details is returned.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Token = z.string().regex(/^[a-f0-9]{64}$/, "This link is not valid.");

export const getSlotOffer = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ token: Token }).parse(d))
  .handler(async ({ data }) => {
    const { publicOffer } = await import("./slot-offers.server");
    const offer = await publicOffer(data.token);
    if (!offer) throw new Error("This link is not valid.");
    return offer;
  });

export const chooseSlotOffer = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ token: Token, slot: z.string().datetime() }).parse(d))
  .handler(async ({ data }) => {
    const { chooseSlot } = await import("./slot-offers.server");
    return chooseSlot(data.token, data.slot);
  });

export const declineSlotOffer = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ token: Token, note: z.string().max(500).default("") }).parse(d),
  )
  .handler(async ({ data }) => {
    const { declineSlots } = await import("./slot-offers.server");
    return { ok: await declineSlots(data.token, data.note) };
  });
