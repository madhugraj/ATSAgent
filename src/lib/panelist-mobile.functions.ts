/**
 * Public server functions behind /panel-mobile/<token> — a panel member adds
 * their own mobile. No session: the 64-hex token is the only key, every call is
 * rate-limited per caller (src/server.ts covers all server-fn RPCs), and only
 * their first name, the organisation and the last four digits are returned.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Token = z.string().regex(/^[a-f0-9]{64}$/, "This link is not valid.");

export const getPanelistMobile = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ token: Token }).parse(d))
  .handler(async ({ data }) => {
    const { publicMobileAsk } = await import("./panelist-mobile.server");
    const r = await publicMobileAsk(data.token);
    if (!r) throw new Error("This link is not valid.");
    return r;
  });

export const savePanelistMobile = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        token: Token,
        phone: z.string().trim().max(30).nullable(),
        aiCalls: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { saveMobileByLink } = await import("./panelist-mobile.server");
    const r = await saveMobileByLink(data.token, { phone: data.phone, aiCalls: data.aiCalls });
    if (!r.ok) throw new Error(r.error);
    return r;
  });
