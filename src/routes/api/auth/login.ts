/**
 * POST /api/auth/login — first-party password sign-in.
 * Verifies the scrypt hash in our own Postgres and establishes the
 * atsiq_session httpOnly cookie.
 */
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { db } from "../../../server/db";
import { users } from "@db/schema";
import { hashPassword, isLegacyHash, verifyAnyPassword } from "../../../server/password";
import { createSession, sessionCookie } from "../../../server/identity";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            email?: string;
            password?: string;
          };
          const email = (body.email ?? "").trim().toLowerCase();
          const password = body.password ?? "";

          const [user] = await db
            .select({
              id: users.id,
              email: users.email,
              passwordHash: users.passwordHash,
              emailConfirmedAt: users.emailConfirmedAt,
            })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

          const ok = user?.passwordHash
            ? await verifyAnyPassword(password, user.passwordHash)
            : false;
          if (!user || !ok) {
            return Response.json({ error: "Invalid email or password." }, { status: 401 });
          }
          if (!user.emailConfirmedAt) {
            return Response.json(
              { error: "Confirm your email address first — check your inbox for the link." },
              { status: 403 },
            );
          }

          const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
          const token = await createSession(user.id, {
            ip,
            userAgent: request.headers.get("user-agent"),
          });
          // Transparent upgrade: legacy bcrypt hashes move to scrypt on sign-in.
          const upgrade = isLegacyHash(user.passwordHash!)
            ? { passwordHash: await hashPassword(password) }
            : {};
          await db
            .update(users)
            .set({ lastLoginAt: new Date(), ...upgrade })
            .where(eq(users.id, user.id));

          return new Response(JSON.stringify({ ok: true, email: user.email }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": sessionCookie(token, request),
            },
          });
        } catch (err) {
          console.error("Password sign-in failed", err);
          return Response.json(
            { error: "Sign-in is temporarily unavailable. Please try again in a moment." },
            { status: 503 },
          );
        }
      },
    },
  },
});
