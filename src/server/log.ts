/**
 * Structured server logger (docs/agentic-plan.md §9).
 *
 * One JSON object per line on stdout/stderr, so Cloud Logging (or any
 * collector) indexes fields without parsing prose. Field names follow
 * OpenTelemetry conventions (`trace_id`, `span_id`) so traces can later be
 * exported without changing call sites.
 *
 * Rules: pass ids and short summaries only — never CV, document, mail or
 * prompt text, never secrets, never vendor/model names in user-facing paths.
 */

export type LogFields = {
  trace_id?: string;
  span_id?: string;
  run_id?: string;
  org_id?: string;
  agent?: string;
  tool?: string;
  [key: string]: unknown;
};

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env["LOG_LEVEL"] as Level) ?? "info"] ?? LEVELS.info;
const MAX_FIELD_CHARS = 500;

function clean(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) out[k] = v.message.slice(0, MAX_FIELD_CHARS);
    else if (typeof v === "string") out[k] = v.slice(0, MAX_FIELD_CHARS);
    else out[k] = v;
  }
  return out;
}

function emit(level: Level, msg: string, fields: LogFields) {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({
    severity: level.toUpperCase(),
    time: new Date().toISOString(),
    msg,
    ...clean(fields),
  });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. one per agent run). */
  child(fields: LogFields): Logger;
};

function make(base: LogFields): Logger {
  return {
    debug: (m, f = {}) => emit("debug", m, { ...base, ...f }),
    info: (m, f = {}) => emit("info", m, { ...base, ...f }),
    warn: (m, f = {}) => emit("warn", m, { ...base, ...f }),
    error: (m, f = {}) => emit("error", m, { ...base, ...f }),
    child: (f) => make({ ...base, ...f }),
  };
}

export const log: Logger = make({});
