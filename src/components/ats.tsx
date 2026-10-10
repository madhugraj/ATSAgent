import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
      <div className="space-y-1">
        {eyebrow ? (
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
  }[tone];
  return (
    <div className="panel p-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("num mt-1 text-2xl font-semibold", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function scoreTone(score: number) {
  if (score >= 75) return "success" as const;
  if (score >= 60) return "warning" as const;
  return "destructive" as const;
}

/** Education arrives either as prose or as raw parsed JSON — always show readable text. */
export function educationLabel(raw: string | null | undefined) {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!(value.startsWith("[") || value.startsWith("{"))) return value;

  const pick = (row: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) {
      const v = row?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };

  try {
    const parsed = JSON.parse(value);
    const rows: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((r) => {
        const degree = pick(r, ["degree", "qualification", "course", "program"]);
        const field = pick(r, ["field", "specialisation", "specialization", "branch", "major"]);
        const school = pick(r, ["institution", "college", "school", "university"]);
        const when = pick(r, ["duration", "end_date", "year", "graduation_year", "completed"]);
        const gpa = pick(r, ["gpa", "cgpa", "percentage", "score"]);

        const head = [
          degree,
          field && !degree.toLowerCase().includes(field.toLowerCase()) ? field : "",
        ]
          .filter(Boolean)
          .join(" — ");
        const tail = [school, when, gpa ? `GPA ${gpa}` : ""].filter(Boolean).join(", ");
        return [head, tail].filter(Boolean).join(" — ");
      })
      .filter((s) => s.length > 0)
      .join(" · ");
  } catch {
    return value;
  }
}

export function ScoreBar({
  label,
  score,
  weight,
  weighted,
}: {
  label: string;
  score: number;
  weight?: number;
  weighted?: number;
}) {
  const tone = scoreTone(score);
  const barClass = {
    success: "bg-success",
    warning: "bg-warning",
    destructive: "bg-destructive",
  }[tone];
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium">{label}</span>
        <span className="num shrink-0 text-sm font-semibold">{score}</span>
      </div>
      {weight !== undefined || weighted !== undefined ? (
        <div className="num truncate text-[11px] text-muted-foreground">
          {weight !== undefined ? `weight ${weight}%` : null}
          {weighted !== undefined ? `${weight !== undefined ? " · " : ""}+${weighted} pts` : null}
        </div>
      ) : null}
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", barClass)}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

export function ScoreChip({ score, size = "md" }: { score: number; size?: "sm" | "md" | "lg" }) {
  const tone = scoreTone(score);
  const toneClass = {
    success: "bg-success/12 text-success border-success/30",
    warning: "bg-warning/15 text-warning border-warning/35",
    destructive: "bg-destructive/10 text-destructive border-destructive/30",
  }[tone];
  const sizeClass = {
    sm: "h-7 min-w-11 text-xs",
    md: "h-9 min-w-14 text-sm",
    lg: "h-14 min-w-20 text-2xl",
  }[size];
  return (
    <div
      className={cn(
        "num inline-flex items-center justify-center rounded-md border font-semibold",
        toneClass,
        sizeClass,
      )}
    >
      {score}
    </div>
  );
}

import { STAGE_LABEL, STAGE_TONE, type Stage } from "@/lib/lifecycle";

const STAGE_TONE_CLASS: Record<string, string> = {
  neutral: "border-border bg-surface-2 text-muted-foreground",
  active: "border-ring/40 bg-primary/10 text-primary",
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
};

export function StageBadge({ stage }: { stage: string }) {
  const label = STAGE_LABEL[stage as Stage] ?? stage;
  const tone = STAGE_TONE[stage as Stage] ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium",
        STAGE_TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_dh: "Pending Dept Head",
  pending_hr: "Pending HR Head",
  pending_cbo: "Pending President & CBO",
  approved: "Approved",
  rejected: "Rejected",
  on_hold: "On hold",
  closed: "Closed",
  changes_requested: "Changes requested",
  released: "Released",
  accepted: "Accepted",
  declined: "Declined",
  revoked: "Revoked",
};

export function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "approved" || status === "accepted"
      ? "default"
      : status === "rejected" || status === "declined" || status === "revoked"
        ? "destructive"
        : "outline";
  return <Badge variant={variant}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function SkillPills({
  skills,
  tone = "neutral",
}: {
  skills: string[];
  tone?: "match" | "miss" | "neutral";
}) {
  if (!skills.length) return <span className="text-sm text-muted-foreground">—</span>;
  const toneClass = {
    match: "border-success/30 bg-success/10 text-success",
    miss: "border-destructive/30 bg-destructive/10 text-destructive",
    neutral: "border-border bg-secondary text-secondary-foreground",
  }[tone];
  return (
    <div className="flex flex-wrap gap-1.5">
      {skills.map((s) => (
        <span
          key={s}
          className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", toneClass)}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="panel flex flex-col items-center gap-1 p-10 text-center">
      <p className="font-medium">{title}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export const inr = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        // Compact crores keep two decimals: ₹1.1 Cr must not read as ₹1 Cr.
        maximumFractionDigits: value >= 10_000_000 ? 2 : 0,
        notation: value >= 10_000_000 ? "compact" : "standard",
      }).format(value);
