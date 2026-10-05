/**
 * POST /api/auth/register — first-party credential signup.
 * Creates the user in our own Postgres and emails a confirmation link via
 * SMTP_URL.
 */
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { db } from "../../../server/db";
import { users } from "@db/schema";
import { hashPassword } from "../../../server/password";
import { signActionToken } from "../../../server/action-token";
import { sendTemplateEmail } from "../../../lib/email-templates/send-email";
import { workEmailProblem } from "../../../lib/work-email";
import { passwordProblem } from "../../../lib/password-policy";

export const Route = createFileRoute("/api/auth/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            email?: string;
            password?: string;
            fullName?: string;
          };
          const email = (body.email ?? "").trim().toLowerCase();
          const password = body.password ?? "";
          const fullName = (body.fullName ?? "").trim() || null;

          const problem = workEmailProblem(email);
          if (problem) return Response.json({ error: problem }, { status: 400 });
          const policyProblem = passwordProblem(password);
          if (policyProblem) {
            return Response.json({ error: policyProblem }, { status: 400 });
          }

          const [existing] = await db
            .select({ id: users.id, emailConfirmedAt: users.emailConfirmedAt })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

          if (existing?.emailConfirmedAt) {
            return Response.json(
              { error: "An account with this email already exists. Try signing in instead." },
              { status: 409 },
            );
          }

          const passwordHash = await hashPassword(password);
          let userId: string;
          if (existing) {
            await db.update(users).set({ passwordHash, fullName }).where(eq(users.id, existing.id));
            userId = existing.id;
          } else {
            const rows = await db
              .insert(users)
              .values({ email, passwordHash, fullName })
              .returning({ id: users.id });
            if (!rows[0]) throw new Error("Failed to create the user record.");
            userId = rows[0].id;
          }

          const siteUrl = process.env["PUBLIC_SITE_URL"] ?? new URL(request.url).origin;
          const token = signActionToken(userId, "email-confirm", 48 * 3600 * 1000);
          const confirmationUrl = `${siteUrl}/api/auth/confirm?token=${token}`;

          await sendTemplateEmail("email-confirmation", email, {
            templateData: {
              siteName: "ATSIQ",
              siteUrl,
              recipient: email,
              confirmationUrl,
            },
            idempotencyKey: `email-confirm-${userId}`,
          });

          return Response.json({
            ok: true,
            message: "Check your inbox to confirm your work email, then continue the setup.",
          });
        } catch (err) {
          return Response.json(
            { error: (err as Error).message || "Registration failed." },
            { status: 500 },
          );
        }
      },
    },
  },
});
