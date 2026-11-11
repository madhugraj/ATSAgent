import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getRequisitionPayTerms, setRequisitionPayTerms } from "@/lib/pay-settings.functions";

const KIND_WORDS: Record<string, string> = {
  permanent: "Permanent",
  fixed_term: "Fixed-term contract",
  contract_hourly: "Contract, paid by the hour or day",
  part_time: "Part-time",
  intern: "Internship",
};
const BASIS_WORDS: Record<string, string> = {
  annual: "a year",
  monthly: "a month",
  daily: "a day",
  hourly: "an hour",
};

type Form = {
  zone: string;
  kind: string;
  basis: string;
  currency: string;
  hoursPerWeek: string;
  contractMonths: string;
  extendable: boolean;
  neededBy: string;
};

/** A role's pay terms: zone, kind of work, currency and basis, contract, needed-by date. */
export function RequisitionPayTermsCard({ requisitionId }: { requisitionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["requisition_pay_terms", requisitionId],
    queryFn: () => getRequisitionPayTerms({ data: { id: requisitionId } }),
  });
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const { terms: t, zone, zones, status } = q.data;
  const editable = status === "draft";
  const contract = (k: string) => k === "fixed_term" || k === "contract_hourly";

  function edit() {
    setForm({
      zone: zone ?? "",
      kind: t.kind,
      basis: t.basis,
      currency: t.currency,
      hoursPerWeek: t.hoursPerWeek != null ? String(t.hoursPerWeek) : "",
      contractMonths: t.contractMonths != null ? String(t.contractMonths) : "",
      extendable: Boolean(t.extendable),
      neededBy: t.neededBy ?? "",
    });
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      await setRequisitionPayTerms({
        data: {
          id: requisitionId,
          zone: form.zone || null,
          kind: form.kind as never,
          basis: form.basis as never,
          currency: form.currency,
          hoursPerWeek: form.hoursPerWeek ? Number(form.hoursPerWeek) : null,
          contractMonths:
            contract(form.kind) && form.contractMonths ? Number(form.contractMonths) : null,
          extendable: contract(form.kind) ? form.extendable : null,
          neededBy: form.neededBy || null,
        },
      });
      toast.success("Pay terms saved.");
      setForm(null);
      qc.invalidateQueries({ queryKey: ["requisition_pay_terms", requisitionId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the pay terms");
    } finally {
      setBusy(false);
    }
  }

  if (!form)
    return (
      <div className="space-y-2 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          <dt className="text-muted-foreground">Kind of work</dt>
          <dd className="sm:col-span-2">
            {KIND_WORDS[t.kind] ?? t.kind}
            {contract(t.kind) && t.contractMonths
              ? ` — ${t.contractMonths} months${t.extendable ? ", can be extended" : ""}`
              : ""}
          </dd>
          <dt className="text-muted-foreground">Pays in</dt>
          <dd className="sm:col-span-2">
            {t.currency}, {BASIS_WORDS[t.basis]}
            {zone ? ` (pay zone ${zone})` : ""}
            {t.paysByLocation ? " — by the candidate's location" : ""}
          </dd>
          {t.hoursPerWeek ? (
            <>
              <dt className="text-muted-foreground">Hours a week</dt>
              <dd className="sm:col-span-2">{t.hoursPerWeek}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Needed by</dt>
          <dd className="sm:col-span-2">{t.neededBy ?? "Not set"}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">
          The budget and pay band are in this currency and basis.
        </p>
        {editable ? (
          <Button variant="outline" size="sm" onClick={edit}>
            Change pay terms
          </Button>
        ) : null}
      </div>
    );

  const pickZone = (name: string) => {
    const z = zones.find((x) => x.name === name);
    setForm({ ...form, zone: name, ...(z ? { currency: z.currency, basis: z.basis } : {}) });
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="pt-zone" className="text-xs">
            Pay zone (where the job is)
          </Label>
          <select
            id="pt-zone"
            className="h-9 w-full rounded-md border bg-background px-2"
            value={form.zone}
            onChange={(e) => pickZone(e.target.value)}
          >
            <option value="">No zone — the organisation&apos;s defaults</option>
            {zones.map((z) => (
              <option key={z.id} value={z.name}>
                {z.name} ({z.currency})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-kind" className="text-xs">
            Kind of work
          </Label>
          <select
            id="pt-kind"
            className="h-9 w-full rounded-md border bg-background px-2"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            {Object.entries(KIND_WORDS).map(([k, w]) => (
              <option key={k} value={k}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-needed" className="text-xs">
            Needed by
          </Label>
          <Input
            id="pt-needed"
            type="date"
            value={form.neededBy}
            onChange={(e) => setForm({ ...form, neededBy: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-currency" className="text-xs">
            Currency
          </Label>
          <Input
            id="pt-currency"
            maxLength={3}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-basis" className="text-xs">
            Pay quoted
          </Label>
          <select
            id="pt-basis"
            className="h-9 w-full rounded-md border bg-background px-2"
            value={form.basis}
            onChange={(e) => setForm({ ...form, basis: e.target.value })}
          >
            {Object.entries(BASIS_WORDS).map(([k, w]) => (
              <option key={k} value={k}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pt-hours" className="text-xs">
            Hours a week (if not the zone&apos;s)
          </Label>
          <Input
            id="pt-hours"
            inputMode="decimal"
            value={form.hoursPerWeek}
            onChange={(e) => setForm({ ...form, hoursPerWeek: e.target.value })}
          />
        </div>
        {contract(form.kind) ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="pt-months" className="text-xs">
                Contract length (months)
              </Label>
              <Input
                id="pt-months"
                inputMode="numeric"
                value={form.contractMonths}
                onChange={(e) =>
                  setForm({ ...form, contractMonths: e.target.value.replace(/\D/g, "") })
                }
              />
            </div>
            <label className="flex items-center gap-2 pt-5 text-xs">
              <input
                type="checkbox"
                checked={form.extendable}
                onChange={(e) => setForm({ ...form, extendable: e.target.checked })}
              />
              Can be extended
            </label>
          </>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !/^[A-Z]{3}$/.test(form.currency)} onClick={save}>
          Save pay terms
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
