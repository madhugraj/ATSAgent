const { db } = await import("../src/server/db");
const { sql } = await import("drizzle-orm");
const [r] = (await db.execute(sql`select id, goal, transcript, result, definition_version from agent_runs where org_id = '31a2bf80-18e5-49a9-96da-b2bc8b484127' and agent_type = 'screening' order by created_at desc limit 1`)) as any[];
console.log("version", r.definition_version, "\ngoal:", r.goal.slice(0, 300));
for (const m of r.transcript) {
  if (m.role === "assistant") { if (m.content) console.log("AI:", m.content.slice(0, 900)); for (const c of m.toolCalls ?? []) console.log("CALL", c.name, JSON.stringify(c.args).slice(0, 500)); }
  else if (m.role === "tool") console.log("RESULT", (m.content ?? "").slice(0, 400).replace(/\n/g, " "));
}
process.exit(0);
