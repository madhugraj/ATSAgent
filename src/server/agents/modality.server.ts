/** Drizzle predicates for the voice/text agent filter (src/lib/agent-modality.ts). */
import { inArray, notInArray, sql, type Column, type SQL } from "drizzle-orm";

import { VOICE_AGENT_TYPES, type ModalityFilter } from "../../lib/agent-modality";

/** Spread into an `and(...)`: limits `column` (an agent type) to the chosen modality. */
export function modalityWhere(column: Column, m: ModalityFilter | null | undefined): SQL[] {
  if (m === "voice") return [inArray(column, [...VOICE_AGENT_TYPES] as never[])];
  if (m === "text") return [notInArray(column, [...VOICE_AGENT_TYPES] as never[])];
  return [];
}

/**
 * Raw-SQL clause ` and <expr> [not] in (...)` (empty for "all") for
 * hand-written queries. `expr` must be a trusted column expression; the type
 * list is a constant, never user input.
 */
export function modalityClause(expr: string, m: ModalityFilter | null | undefined): string {
  if (!m || m === "all") return "";
  const list = VOICE_AGENT_TYPES.map((t) => `'${t}'`).join(", ");
  return ` and ${expr} ${m === "voice" ? "in" : "not in"} (${list})`;
}

export function modalitySql(expr: string, m: ModalityFilter | null | undefined): SQL {
  return sql.raw(modalityClause(expr, m));
}

/** Same filter for rows that belong to a run (`<alias>.run_id`). */
export function modalityViaRun(alias: string, m: ModalityFilter | null | undefined): SQL {
  if (!m || m === "all") return sql.raw("");
  return sql.raw(
    ` and exists (select 1 from agent_runs mr where mr.id = ${alias}.run_id${modalityClause("mr.agent_type", m)})`,
  );
}
