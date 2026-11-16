/**
 * POST /api/auth/request-reset — emails a single-use password reset link.
 * Always answers the same way so the endpoint never discloses which
 * addresses have accounts.
 */
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { db } from "../../../server/db";
import { users } from "@db/schema";
import { signActionToken } from "../../../server/action-token";
import { sendTemplateEmail } from "../../../lib/email-templates/send-email";

const GENERIC = "If that address has an ATSIQ account, a reset link is on its way.";

export const Route = createFileRoute("/api/auth/request-reset")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json().catch(() => ({}))) as { email?: string };
          const email = (body.email ?? "").trim().toLowerCase();
          if (!email) return Response.json({ error: "Enter your work email." }, { status: 400 });

          const [user] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

          if (user) {
            const siteUrl = process.env["PUBLIC_SITE_URL"] ?? new URL(request.url).origin;
            const token = signActionToken(user.id, "password-reset", 60 * 60 * 1000);
            await sendTemplateEmail("password-recovery", email, {
              templateData: {
                siteName: "ATSIQ",
                confirmationUrl: `${siteUrl}/auth/reset?token=${token}`,
              },
            });
          }
          return Response.json({ ok: true, message: GENERIC });
        } catch (err) {
          // The reply stays generic (no account enumeration), but the failure
          // is logged so a broken relay is diagnosable server-side.
          console.error("Password-reset email failed to send", err);
          return Response.json({ ok: true, message: GENERIC });
        }
      },
    },
  },
});
