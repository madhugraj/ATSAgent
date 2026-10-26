// Local test watcher: the new role's thread, its open requests and agent runs.
const { db } = await import("../src/server/db");
const { sql } = await import("drizzle-orm");
const conv = process.argv[2] ?? "b6002a22-7595-4d87-9a59-3de04b63e852";
const since = process.argv[3] ?? "1 hour";
const msgs = (await db.execute(sql`select to_char(created_at at time zone 'Asia/Kolkata','HH24:MI:SS') t, coalesce(agent_type, role) who, left(regexp_replace(body, '[[:space:]]+', ' ', 'g'), 260) body, card->>'type' card from hiring_messages where conversation_id = ${conv} and created_at > now() - ${since}::interval order by created_at`)) as any[];
for (const m of msgs) console.log(`${m.t} [${m.who}${m.card ? ` · ${m.card}` : ""}] ${m.body}`);
const [c] = (await db.execute(sql`select org_id, requisition_id from hiring_conversations where id = ${conv}`)) as any[];
console.log("--- open requests");
console.log(JSON.stringify(await db.execute(sql`select t.kind, t.status, left(t.title, 90) title, t.assignee_role from agent_tasks t join agent_runs r on r.id = t.run_id where t.org_id = ${c.org_id} and t.status = 'open' and (r.conversation_id = ${conv} or r.subject_id = ${c.requisition_id})`)));
console.log("--- runs");
console.log(JSON.stringify(await db.execute(sql`select agent_type, status, left(coalesce(last_error,''),80) err, to_char(updated_at at time zone 'Asia/Kolkata','HH24:MI:SS') t from agent_runs where org_id = ${c.org_id} and created_at > now() - ${since}::interval order by created_at`)));
console.log("--- requisition");
console.log(JSON.stringify(await db.execute(sql`select code, status from requisitions where id = ${c.requisition_id}`)));
process.exit(0);
