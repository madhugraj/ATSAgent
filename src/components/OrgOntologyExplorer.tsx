/**
 * The organisation ontology explorer: the 3D map, a time slider that replays
 * how new roles formed month by month, and a side panel — the emerging roles,
 * then the detail of whatever is selected. For an emerging role a person can
 * ask for a suggested name and confirm it into job architecture.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, Video } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { OntologyFocus, OntologyRecorder } from "@/components/OrgOntology3D";
import {
  confirmEmergingRole,
  suggestRoleName,
  type EmergingRole,
  type OrgOntology,
} from "@/lib/org-ontology.functions";

const OrgOntology3D = lazy(() =>
  import("@/components/OrgOntology3D").then((m) => ({ default: m.OrgOntology3D })),
);

const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
};
const statusAt = (e: EmergingRole, t: number) =>
  t < e.signal
    ? null
    : e.established !== null && t >= e.established
      ? "established"
      : e.emerging !== null && t >= e.emerging
        ? "emerging"
        : "signal";
const BADGE: Record<string, string> = {
  signal: "bg-muted text-muted-foreground",
  emerging: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  established: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function Spark({ values, upto }: { values: number[]; upto: number }) {
  const w = 280,
    h = 40,
    max = Math.max(1, ...values);
  const pts = values
    .slice(0, upto + 1)
    .map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - 4 - (v / max) * (h - 8)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-10 w-full" aria-hidden>
      <line x1={0} x2={w} y1={h - 4} y2={h - 4} className="stroke-border" />
      <polyline points={pts} fill="none" stroke="#e8a33a" strokeWidth={2} />
    </svg>
  );
}

export function OrgOntologyExplorer({
  ont,
  queryKey,
  full = false,
  initial,
  onClose,
}: {
  ont: OrgOntology;
  queryKey: readonly unknown[];
  /** Full-screen popup mode: taller map, close instead of expand. */
  full?: boolean;
  initial?: { t: number; focus: OntologyFocus } | undefined;
  onClose?: (() => void) | undefined;
}) {
  const last = ont.months.length - 1;
  const [t, setT] = useState(initial?.t ?? last);
  const [playing, setPlaying] = useState(false);
  const [focus, setFocus] = useState<OntologyFocus>(initial?.focus ?? null);
  const [expanded, setExpanded] = useState(false);
  const recorder = useRef<OntologyRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  /** Replays the timeline from the first month and saves it as a video. */
  const recordReplay = async () => {
    if (!recorder.current || recording) return;
    setRecording(true);
    setFocus(null);
    setT(0);
    setPlaying(true);
    try {
      const blob = await recorder.current.record((last + 1) * 900 + 1800);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `org-ontology-${ont.domain.key}-${new Date().toISOString().slice(0, 10)}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast.success("Video saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the video");
    } finally {
      setRecording(false);
    }
  };
  const mapH = full ? "calc(100vh - 150px)" : 620;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((x) => {
        if (x >= last) {
          setPlaying(false);
          return x;
        }
        return x + 1;
      });
    }, 900);
    return () => clearInterval(id);
  }, [playing, last]);

  const nameOf = (id: string) =>
    [...ont.roles, ...ont.emerging].find((r) => r.id === id)?.name ?? id;
  const visible = ont.emerging.filter((e) => statusAt(e, t));
  const counts: { signal: number; emerging: number; established: number } = {
    signal: 0,
    emerging: 0,
    established: 0,
  };
  for (const e of visible) counts[statusAt(e, t)!] += 1;

  const body = (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-2">
        {mounted ? (
          <div className="relative">
            {expanded ? (
              // one live 3D scene at a time: the popup owns it while open
              <div
                className="flex items-center justify-center rounded-xl bg-slate-900 text-sm text-slate-400"
                style={{ height: mapH }}
              >
                Open in full screen
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="animate-pulse rounded-xl bg-slate-900" style={{ height: mapH }} />
                }
              >
                <OrgOntology3D
                  ont={ont}
                  time={t}
                  focus={focus}
                  onSelect={setFocus}
                  height={mapH}
                  recorderRef={recorder}
                />
              </Suspense>
            )}
            <button
              type="button"
              onClick={() => (full ? onClose?.() : setExpanded(true))}
              className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/60"
              aria-label={full ? "Close full screen" : "Expand to full screen"}
            >
              {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              {full ? "Close" : "Full screen"}
            </button>
            {!expanded && (
              <button
                type="button"
                onClick={() => void recordReplay()}
                disabled={recording}
                className="absolute right-3 top-12 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/60 disabled:opacity-80"
                aria-label="Record the replay as a video"
              >
                {recording ? (
                  <span className="inline-block size-2.5 animate-pulse rounded-full bg-red-500" />
                ) : (
                  <Video className="size-3.5" />
                )}
                {recording ? "Recording…" : "Record video"}
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-xl bg-slate-900" style={{ height: mapH }} />
        )}
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play how roles formed"}
            onClick={() => {
              if (!playing && t >= last) setT(0);
              setPlaying((p) => !p);
            }}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
          >
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">
            {monthLabel(ont.months[t]!)}
          </span>
          <input
            type="range"
            min={0}
            max={last}
            value={t}
            onChange={(e) => {
              setPlaying(false);
              setT(Number(e.target.value));
            }}
            className="flex-1 accent-primary"
            aria-label="Month"
          />
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {counts.established} established · {counts.emerging} emerging · {counts.signal} early
            signal
          </span>
        </div>
      </div>

      <aside
        className="overflow-y-auto rounded-xl border border-border bg-card p-4 text-[13px]"
        style={{ maxHeight: full ? "calc(100vh - 90px)" : 680 }}
      >
        {focus?.kind === "emerging" ? (
          <EmergingDetail
            e={ont.emerging.find((x) => x.id === focus.id)!}
            t={t}
            months={ont.months}
            nameOf={nameOf}
            onBack={() => setFocus(null)}
            queryKey={queryKey}
          />
        ) : focus?.kind === "role" ? (
          (() => {
            const r = ont.roles.find((x) => x.id === focus.id);
            const kids = ont.emerging.filter((e) => e.parents.includes(focus.id));
            return (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold">{r?.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Established role ·{" "}
                    {r?.source === "seed"
                      ? `${ont.domain.name} starter role`
                      : "learned from your requisitions"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat n={r?.demand ?? 0} label="requisitions" />
                  <Stat n={r?.supply ?? 0} label="in your pool" />
                </div>
                <Section title="New roles growing out of it">
                  {kids.length ? (
                    kids.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className="mr-1 mt-1 rounded-full border border-amber-500/40 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                        onClick={() => setFocus({ kind: "emerging", id: e.id })}
                      >
                        {e.name}
                      </button>
                    ))
                  ) : (
                    <p className="text-muted-foreground">None yet.</p>
                  )}
                </Section>
                <Back onClick={() => setFocus(null)} />
              </div>
            );
          })()
        ) : focus?.kind === "skill" ? (
          (() => {
            const fam = ont.families.find((f) => f.skills.some((s) => s.name === focus.name));
            const s = fam?.skills.find((x) => x.name === focus.name);
            const inRoles = ont.emerging.filter((e) =>
              e.skills.some((x) => x.toLowerCase() === focus.name.toLowerCase()),
            );
            return (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold">{focus.name}</p>
                  <p className="text-xs text-muted-foreground">{fam?.name}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat n={s?.demand ?? 0} label="requisitions ask" />
                  <Stat n={s?.supply ?? 0} label="in your pool" />
                </div>
                {inRoles.length > 0 && (
                  <Section title="Part of new roles">
                    {inRoles.map((e) => (
                      <p key={e.id} className="text-amber-700 dark:text-amber-400">
                        {e.name}
                      </p>
                    ))}
                  </Section>
                )}
                <Back onClick={() => setFocus(null)} />
              </div>
            );
          })()
        ) : (
          <div>
            <p className="text-sm font-semibold">New roles in {ont.domain.name.toLowerCase()}</p>
            <p className="text-xs text-muted-foreground">
              Where requisitions keep combining skills from two roles · as of{" "}
              {monthLabel(ont.months[t]!)}
            </p>
            <div className="mt-2 divide-y divide-border">
              {visible.length === 0 ? (
                <p className="py-3 text-muted-foreground">
                  {ont.emerging.length === 0
                    ? "No new roles detected yet. They appear as requisitions start asking for skills from two roles together."
                    : "None yet at this point — press play."}
                </p>
              ) : (
                visible.map((e) => {
                  const st = statusAt(e, t)!;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setFocus({ kind: "emerging", id: e.id })}
                      className="flex w-full items-start justify-between gap-2 py-2.5 text-left hover:text-amber-700"
                    >
                      <span>
                        <span className="block font-semibold">{e.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {e.parents.map(nameOf).join(" + ")} · {e.demand[t]} asks · {e.supply} in
                          pool
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${BADGE[st]}`}
                      >
                        {e.confirmed && st === "established" ? "confirmed" : st}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Built from {ont.stats.requisitions} requisitions and {ont.stats.candidates}{" "}
              candidates. Drag to rotate, Ctrl/⌘ + scroll to zoom, click anything.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
  return (
    <>
      {body}
      {expanded && (
        <Dialog open onOpenChange={(o) => !o && setExpanded(false)}>
          <DialogContent className="h-[100vh] w-[100vw] max-w-none gap-0 rounded-none border-0 p-3 sm:rounded-none [&>button]:hidden">
            <DialogTitle className="sr-only">{ont.domain.name} organisation ontology</DialogTitle>
            <OrgOntologyExplorer
              ont={ont}
              queryKey={queryKey}
              full
              initial={{ t, focus }}
              onClose={() => setExpanded(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
      <p className="text-base font-semibold tabular-nums">{n}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}
function Back({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium text-primary hover:underline"
    >
      ← All new roles
    </button>
  );
}

function EmergingDetail({
  e,
  t,
  months,
  nameOf,
  onBack,
  queryKey,
}: {
  e: EmergingRole;
  t: number;
  months: string[];
  nameOf: (id: string) => string;
  onBack: () => void;
  queryKey: readonly unknown[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(e.name);
  const [suggested, setSuggested] = useState<{ name: string; reason: string } | null>(null);
  useEffect(() => {
    setName(e.name);
    setSuggested(null);
  }, [e.id, e.name]);
  const suggest = useMutation({
    mutationFn: () => suggestRoleName({ data: { roleId: e.id } }),
    onSuccess: (r) => {
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setSuggested(r);
      setName(r.name);
    },
  });
  const confirm = useMutation({
    mutationFn: () =>
      confirmEmergingRole({ data: { roleId: e.id, name, suggested: suggested?.name ?? null } }),
    onSuccess: (r) => {
      toast.success(`${r.name} added to job architecture`);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not confirm the role"),
  });
  const st = statusAt(e, t);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">{e.name}</p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${BADGE[st ?? "signal"]}`}
        >
          {e.confirmed ? "confirmed" : (st ?? "not yet")}
        </span>
      </div>
      <p className="text-muted-foreground">
        Born from <b className="text-foreground">{e.parents.map(nameOf).join(" + ")}</b>
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Stat n={e.demand[t] ?? 0} label="requisitions" />
        <Stat n={e.supply} label="in your pool" />
        <Stat n={monthLabel(months[e.signal]!)} label="first signal" />
      </div>
      <Section title="Requisitions over time">
        <Spark values={e.demand} upto={t} />
      </Section>
      <Section title="Skill bundle">
        <div className="flex flex-wrap gap-1">
          {e.skills.map((s) => (
            <span key={s} className="rounded-full border border-border px-2 py-0.5 text-xs">
              {s}
            </span>
          ))}
        </div>
      </Section>
      <Section title="Titles in your requisitions">
        <p className="text-muted-foreground">{e.titles.join(" · ")}</p>
      </Section>
      <Section title="Why it was flagged">
        <p className="text-muted-foreground">
          Your requisitions keep asking for skills from {e.parents.map(nameOf).join(" and ")}{" "}
          together ({e.requisitions} so far), and no single established role covers them.
        </p>
      </Section>
      {!e.confirmed && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-xs font-medium">Add to job architecture</p>
          <input
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
            aria-label="Role name"
          />
          {suggested && (
            <p className="text-xs text-muted-foreground">Suggested: {suggested.reason}</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={suggest.isPending}
              onClick={() => suggest.mutate()}
            >
              {suggest.isPending ? "Suggesting…" : "Suggest a name"}
            </Button>
            <Button
              size="sm"
              disabled={confirm.isPending || name.trim().length < 2}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? "Adding…" : "Confirm role"}
            </Button>
          </div>
        </div>
      )}
      <Back onClick={onBack} />
    </div>
  );
}
