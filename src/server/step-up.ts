/**
 * Step-up re-authentication (docs/guardrails.md P2-4; migration 0066).
 *
 * The most consequential human actions — releasing an offer to a candidate
 * and rejecting candidates in bulk (directly, or by approving an agent's
 * rejection batch or offer release in the inbox) — need the person to have
 * re-entered their password in this session within STEP_UP_WINDOW_MS. A
 * stolen or left-open session alone cannot do them.
 *
 * The check runs in the server-function handlers (the human entry points),
 * never in the shared cores: agents cannot perform these actions at all.
 * Failed attempts are audited and throttled per user.
 */
import { and, count, eq, gte } from "drizzle-orm";

import { db } from "./db";
import { auditLog, sessions, users } from "@db/schema";

export const STEP_UP_WINDOW_MS = 10 * 60_000;
/** Wrong passwords per user in STEP_UP_LOCK_MS before step-up is refused for a while. */
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_LOCK_MS = 15 * 60_000;

/** Error message prefix the client recognises to show the password prompt. */
export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";
export const STEP_UP_MESSAGE = `${STEP_UP_REQUIRED}: Confirm your password to continue — this action needs it.`;

/** Pure: is a re-authentication at `at` still fresh at `now`? */
export function stepUpFresh(at: Date | null | undefined, now = new Date()): boolean {
  return Boolean(at) && now.getTime() - at!.getTime() < STEP_UP_WINDOW_MS;
}

async function currentSession(userId: string, request: Request) {
  const { sessionTokenHash } = await import("./identity");
  const tokenHash = await sessionTokenHash(request);
  if (!tokenHash) return null;
  const [row] = await db
    .select({ id: sessions.id, reauthenticatedAt: sessions.reauthenticatedAt })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Throw STEP_UP_MESSAGE unless this session re-authenticated recently. */
export async function assertStepUp(userId: string, request: Request): Promise<void> {
  const s = await currentSession(userId, request);
  if (!s || !stepUpFresh(s.reauthenticatedAt)) throw new Error(STEP_UP_MESSAGE);
}

/**
 * Check the password and mark this session re-authenticated. Audited either
 * way (`auth.step_up`, `auth.step_up_failed`); locked after repeated failures.
 */
export async function confirmStepUp(input: {
  userId: string;
  orgId: string;
  password: string;
  request: Request;
}): Promise<void> {
  const since = new Date(Date.now() - STEP_UP_LOCK_MS);
  const [failed] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, input.userId),
        eq(auditLog.action, "auth.step_up_failed"),
        gte(auditLog.createdAt, since),
      ),
    );
  if ((failed?.n ?? 0) >= STEP_UP_MAX_FAILURES)
    throw new Error("Too many wrong passwords. Wait 15 minutes, then try again.");

  const [u] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const { verifyAnyPassword } = await import("./password");
  const ok =
    Boolean(u?.passwordHash) && (await verifyAnyPassword(input.password, u!.passwordHash!));
  const { writeAudit } = await import("./audit");
  if (!ok) {
    await writeAudit({
      actor: `user:${input.userId}`,
      actorUserId: input.userId,
      orgId: input.orgId,
      action: "auth.step_up_failed",
      entityType: "session",
      entityId: null,
      detail: {},
    });
    throw new Error("That password is not correct.");
  }
  const s = await currentSession(input.userId, input.request);
  if (!s) throw new Error("Your session has ended. Sign in again.");
  await db
    .update(sessions)
    .set({ reauthenticatedAt: new Date() })
    .where(and(eq(sessions.id, s.id), eq(sessions.userId, input.userId)));
  await writeAudit({
    actor: `user:${input.userId}`,
    actorUserId: input.userId,
    orgId: input.orgId,
    action: "auth.step_up",
    entityType: "session",
    entityId: s.id,
    detail: {},
  });
}
