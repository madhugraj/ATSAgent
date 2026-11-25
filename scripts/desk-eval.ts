/**
 * Hiring desk routing evals against the live model.
 *
 *   bun --env-file=.env.local scripts/desk-eval.ts [conversationId]
 *
 * Uses an existing desk thread with a requisition on a LOCAL database (the
 * organisation's own AI settings; every call is logged to ai_usage_events).
 * runTurn only reads, so the thread is not changed. EVAL_ONLY=<text> filters
 * scenarios by name. Exits non-zero when any scenario fails.
 */
const url = process.env.DATABASE_URL ?? "";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to run evals against a non-local database");
}

const { db } = await import("../src/server/db");
const { and, eq, isNotNull, desc } = await import("drizzle-orm");
const { hiringConversations } = await import("@db/schema");
const { runTurn } = await import("../src/server/desk/desk.server");
const { deskScenarios } = await import("./evals/desk-scenarios");

const id = process.argv[2];
const [conv] = await db
  .select()
  .from(hiringConversations)
  .where(
    id
      ? eq(hiringConversations.id, id)
      : and(eq(hiringConversations.status, "active"), isNotNull(hiringConversations.requisitionId)),
  )
  .orderBy(desc(hiringConversations.createdAt))
  .limit(1);
if (!conv) throw new Error("No active desk thread with a requisition found.");
console.log(`Thread: ${conv.title}\n`);

const only = process.env["EVAL_ONLY"];
let fail = 0;
for (const s of deskScenarios.filter((x) => !only || x.name.includes(only))) {
  const history = [...(s.history ?? []), { role: "user", body: s.message }];
  const res = await runTurn(conv.orgId, conv, history);
  if (!res.ok) {
    fail++;
    console.log(`✗ ${s.name}: model error ${res.message}`);
    continue;
  }
  const c = res.turn.command as Record<string, unknown>;
  const problems: string[] = [];
  if (c["type"] !== s.expect.type) problems.push(`type ${String(c["type"])}`);
  if (s.expect.stage && c["stage"] !== s.expect.stage) problems.push(`stage ${String(c["stage"])}`);
  if (s.expect.names) {
    const got = ((c["names"] as string[] | undefined) ?? []).map((n) => n.toLowerCase());
    if (!s.expect.names.every((n) => got.some((g) => g.includes(n))))
      problems.push(`names ${JSON.stringify(c["names"])}`);
  }
  if (problems.length) {
    fail++;
    console.log(`✗ ${s.name}: ${problems.join(", ")} — reply: ${res.turn.reply.slice(0, 120)}`);
  } else console.log(`✓ ${s.name}`);
}
console.log(`\n${fail ? `${fail} failed` : "all passed"}`);
process.exit(fail ? 1 : 0);
