import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Scale } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addPolicySource,
  getLabourPolicy,
  seedPolicySources,
  setPolicySourceActive,
} from "@/lib/labour-policy.functions";

const STATUS_WORDS: Record<string, string> = {
  new: "Found",
  proposed: "Waiting for the HR head",
  approved: "In force",
  rejected: "Declined",
};
const READ_WORDS: Record<string, string> = {
  first: "read",
  changed: "changed",
  unchanged: "no change",
  failed: "failed",
};

/**
 * Labour & hiring policy (docs/labour-policy-agent-plan.md): the official sources
 * the Labour law & policy agent reads for each place you hire, and what it found.
 * Changes are decided in the approvals inbox; approved ones become rules every
 * agent works within.
 */
export function LabourPolicyCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["labour_policy"], queryFn: () => getLabourPolicy() });
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState({ url: "", label: "", country: "" });
  if (!q.data) return null;
  const { sources, findings, canDecide } = q.data;

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      qc.invalidateQueries({ queryKey: ["labour_policy"] });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const srcValid = /^https:\/\//.test(src.url.trim()) && src.label.trim().length >= 3;

  return (
    <section className="panel space-y-4 p-4" aria-labelledby="labour-policy-title">
      <h2 id="labour-policy-title" className="flex items-center gap-2 text-sm font-semibold">
        <Scale className="size-4" /> Labour &amp; hiring policy
      </h2>
      <p className="text-sm text-muted-foreground">
        Each week the Labour law &amp; policy agent reads these official sources for the places you
        hire — only these, never a search — and brings each change that matters to hiring to the HR
        head with the source&apos;s exact words. An approved change becomes a rule every agent works
        within. It is not legal advice; check with counsel where it matters. Switch the agent on
        under Agent settings.
      </p>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Sources</h3>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sources yet. Add the official pages for your pay zones
            {canDecide ? " with the button below" : " (the HR head can)"}.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="underline">
                  {s.label}
                </a>
                <span className="text-xs text-muted-foreground">
                  {s.country ?? s.level}
                  {s.lastRead
                    ? ` · ${READ_WORDS[s.lastRead.status] ?? s.lastRead.status} ${s.lastRead.at.slice(0, 10)}`
                    : " · not read yet"}
                  {s.active ? "" : " · paused"}
                </span>
                {canDecide ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () => setPolicySourceActive({ data: { id: s.id, active: !s.active } }),
                        s.active ? "Paused." : "Resumed.",
                      )
                    }
                  >
                    {s.active ? "Pause" : "Resume"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canDecide ? (
          <div className="mt-2 space-y-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                act(() => seedPolicySources(), "Official sources added for your pay zones.")
              }
            >
              Add the official sources for our pay zones
            </Button>
            <div className="grid items-end gap-2 sm:grid-cols-4">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ps-url" className="text-xs">
                  Another official page (https)
                </Label>
                <Input
                  id="ps-url"
                  value={src.url}
                  onChange={(e) => setSrc({ ...src, url: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ps-label" className="text-xs">
                  Name
                </Label>
                <Input
                  id="ps-label"
                  value={src.label}
                  onChange={(e) => setSrc({ ...src, label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ps-country" className="text-xs">
                  Country code (optional)
                </Label>
                <Input
                  id="ps-country"
                  maxLength={2}
                  value={src.country}
                  onChange={(e) => setSrc({ ...src, country: e.target.value.toUpperCase() })}
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !srcValid}
              onClick={async () => {
                const ok = await act(
                  () =>
                    addPolicySource({
                      data: {
                        url: src.url.trim(),
                        label: src.label.trim(),
                        country: src.country.trim() || null,
                      },
                    }),
                  "Source added.",
                );
                if (ok) setSrc({ url: "", label: "", country: "" });
              }}
            >
              Add source
            </Button>
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
          What it found
        </h3>
        {findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {findings.map((f) => (
              <li key={f.id} className="rounded-md border p-2">
                <p className="font-medium">
                  {f.zone ?? "All locations"} · {f.area.replace(/_/g, " ")} —{" "}
                  {STATUS_WORDS[f.status] ?? f.status}
                  {f.effectiveDate ? ` · effective ${f.effectiveDate}` : ""}
                </p>
                <p>{f.rule}</p>
                <p className="text-xs text-muted-foreground">
                  “{f.quote}” —{" "}
                  <a href={f.url} target="_blank" rel="noreferrer noopener" className="underline">
                    source
                  </a>
                  {f.decisionNote ? ` · ${f.decisionNote}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {findings.some((f) => f.status === "proposed") ? (
          <Link to="/inbox" className="mt-2 inline-block text-sm underline">
            Decide waiting changes in the approvals inbox
          </Link>
        ) : null}
      </div>
    </section>
  );
}
