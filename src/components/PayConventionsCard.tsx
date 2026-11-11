import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Globe2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CodeSelect, CountryMultiSelect, CURRENCY_OPTIONS } from "@/components/code-select";
import { addExchangeRate, getPaySettings, savePayConventions } from "@/lib/pay-settings.functions";
import type { ConventionZone, PayConventions } from "@/lib/pay-settings";
import { currencyForCountries, isCurrencyCode } from "@/lib/iso";

const BASIS_WORDS: Record<string, string> = {
  annual: "a year",
  monthly: "a month",
  daily: "a day",
  hourly: "an hour",
};

const EMPTY_ZONE = {
  name: "",
  countries: [] as string[],
  cities: "",
  currency: "",
  basis: "annual",
  paymentsPerYear: "12",
  hoursPerWeek: "40",
  region: "",
};

/**
 * The organisation's pay conventions (docs/pay-terms-plan.md): reporting currency,
 * tolerance, pay zones, pooling regions and exchange rates. HR leadership changes
 * them here or approves what the Organisation context agent proposes.
 */
export function PayConventionsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pay_settings"], queryFn: () => getPaySettings() });
  const [busy, setBusy] = useState(false);
  const [zone, setZone] = useState(EMPTY_ZONE);
  const [rate, setRate] = useState({ from: "", to: "", rate: "", source: "" });
  const [head, setHead] = useState<{ reporting?: string; far?: string }>({});
  if (!q.data) return null;
  const { conventions: c, pending, rates, canDecide } = q.data;

  async function save(next: PayConventions, done: string) {
    setBusy(true);
    try {
      const out = await savePayConventions({ data: next });
      toast.success(out.changes.length ? done : "Nothing changed.");
      qc.invalidateQueries({ queryKey: ["pay_settings"] });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveHead() {
    const next = {
      ...c,
      reportingCurrency: (head.reporting ?? c.reportingCurrency).toUpperCase(),
      farAbovePct: Number(head.far ?? c.farAbovePct),
    };
    if (await save(next, "Saved.")) setHead({});
  }

  async function saveZone() {
    const z: ConventionZone = {
      name: zone.name.trim(),
      countries: zone.countries.map((x) => x.trim().toUpperCase()).filter(Boolean),
      cities: zone.cities
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      currency: zone.currency.trim().toUpperCase(),
      basis: zone.basis as ConventionZone["basis"],
      paymentsPerYear: Number(zone.paymentsPerYear),
      includes: c.zones.find((x) => x.name.toLowerCase() === zone.name.trim().toLowerCase())
        ?.includes ?? ["base"],
      hoursPerWeek: Number(zone.hoursPerWeek),
      workingDaysPerYear: 250,
      kinds: c.kindsOfWork,
      contractTypes: [],
      entity: null,
      geoFactor: null,
      region: zone.region.trim() || null,
    };
    const regions =
      z.region && !c.regions.some((r) => r.name.toLowerCase() === z.region!.toLowerCase())
        ? [...c.regions, { name: z.region, rule: "same_region" as const }]
        : c.regions;
    const zones = [...c.zones.filter((x) => x.name.toLowerCase() !== z.name.toLowerCase()), z];
    if (await save({ ...c, regions, zones }, `Zone ${z.name} saved.`)) setZone(EMPTY_ZONE);
  }

  async function removeZone(name: string) {
    await save({ ...c, zones: c.zones.filter((z) => z.name !== name) }, `Zone ${name} removed.`);
  }

  async function saveRate() {
    setBusy(true);
    try {
      await addExchangeRate({
        data: { from: rate.from, to: rate.to, rate: Number(rate.rate), source: rate.source },
      });
      toast.success("Rate saved.");
      setRate({ from: "", to: "", rate: "", source: "" });
      qc.invalidateQueries({ queryKey: ["pay_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the rate");
    } finally {
      setBusy(false);
    }
  }

  const zoneValid =
    zone.name.trim() &&
    isCurrencyCode(zone.currency.trim()) &&
    zone.countries.length > 0 &&
    Number(zone.paymentsPerYear) >= 12 &&
    Number(zone.paymentsPerYear) <= 16 &&
    Number(zone.hoursPerWeek) > 0;
  const rateValid =
    isCurrencyCode(rate.from.trim()) &&
    isCurrencyCode(rate.to.trim()) &&
    Number(rate.rate) > 0 &&
    rate.source.trim().length >= 2;

  return (
    <section className="panel space-y-4 p-4" aria-labelledby="pay-conventions-title">
      <h2 id="pay-conventions-title" className="flex items-center gap-2 text-sm font-semibold">
        <Globe2 className="size-4" /> Pay, currency and pay zones
      </h2>
      <p className="text-sm text-muted-foreground">
        Each role pays in its pay zone&apos;s currency and way of quoting pay; figures are kept as
        the candidate said them and shown in your reporting currency beside. Decisions compare in
        the role&apos;s own currency, so a rate move alone never changes one. The Organisation
        context agent can propose these for the HR head to approve.
      </p>

      {pending ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          <p className="font-medium">A proposal is waiting for the HR head</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {pending.changes.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <Link to="/inbox" className="mt-2 inline-block text-sm underline">
            Decide it in the approvals inbox
          </Link>
        </div>
      ) : null}

      <div className="grid items-end gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="pc-reporting" className="text-xs">
            Reporting currency
          </Label>
          <CodeSelect
            id="pc-reporting"
            options={CURRENCY_OPTIONS}
            disabled={!canDecide}
            value={head.reporting ?? c.reportingCurrency}
            onChange={(code) => setHead({ ...head, reporting: code })}
            placeholder="Pick the reporting currency"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pc-far" className="text-xs">
            Over a band&apos;s ceiling by more than (%) blocks
          </Label>
          <Input
            id="pc-far"
            inputMode="numeric"
            disabled={!canDecide}
            value={head.far ?? String(c.farAbovePct)}
            onChange={(e) => setHead({ ...head, far: e.target.value.replace(/\D/g, "") })}
          />
        </div>
        {canDecide ? (
          <Button
            variant="outline"
            disabled={busy || Object.keys(head).length === 0}
            onClick={saveHead}
          >
            Save
          </Button>
        ) : null}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Pay zones</h3>
        {c.zones.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pay zones yet — every role pays in {c.reportingCurrency},{" "}
            {BASIS_WORDS[c.payBasisDefault]}.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Zone</th>
                <th className="font-medium">Where</th>
                <th className="font-medium">Pays in</th>
                <th className="font-medium">Payments a year</th>
                <th className="font-medium">Hours a week</th>
                <th className="font-medium">Region</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.zones.map((z) => (
                <tr key={z.name} className="border-t">
                  <td className="py-1">{z.name}</td>
                  <td>
                    {z.countries.join(", ")}
                    {z.cities.length ? ` — ${z.cities.join(", ")}` : ""}
                  </td>
                  <td>
                    {z.currency}, {BASIS_WORDS[z.basis]}
                  </td>
                  <td>{z.paymentsPerYear}</td>
                  <td>{z.hoursPerWeek}</td>
                  <td>{z.region ?? "—"}</td>
                  <td className="text-right">
                    {canDecide ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => removeZone(z.name)}
                        aria-label={`Remove zone ${z.name}`}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canDecide ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs font-semibold">Add a zone, or change one by its name</p>
          <p className="text-xs text-muted-foreground">
            A pay zone is one place&apos;s way of paying: a country (or a few cities inside one),
            its currency and how pay is quoted. One country-wide zone per country.
          </p>
          <div className="grid gap-2 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="pz-name" className="text-xs">
                Zone name
              </Label>
              <Input
                id="pz-name"
                placeholder="Italy, or Milan office"
                value={zone.name}
                onChange={(e) => {
                  const name = e.target.value;
                  const match = c.zones.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
                  if (match)
                    setZone({
                      ...zone,
                      name,
                      countries: match.countries,
                      cities: match.cities.join(", "),
                      currency: match.currency,
                      basis: match.basis,
                      paymentsPerYear: String(match.paymentsPerYear),
                      hoursPerWeek: String(match.hoursPerWeek),
                      region: match.region ?? "",
                    });
                  else setZone({ ...zone, name });
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pz-countries" className="text-xs">
                Countries
              </Label>
              <CountryMultiSelect
                id="pz-countries"
                value={zone.countries}
                onChange={(codes) => {
                  const auto = currencyForCountries(codes);
                  setZone((z) => ({
                    ...z,
                    countries: codes,
                    currency: auto ?? (isCurrencyCode(z.currency) ? z.currency : ""),
                  }));
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pz-cities" className="text-xs">
                Only these cities (optional)
              </Label>
              <Input
                id="pz-cities"
                placeholder="Leave empty for the whole country"
                value={zone.cities}
                onChange={(e) => setZone({ ...zone, cities: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pz-currency" className="text-xs">
                Currency
              </Label>
              <CodeSelect
                id="pz-currency"
                options={CURRENCY_OPTIONS}
                value={zone.currency}
                onChange={(code) => setZone({ ...zone, currency: code })}
                placeholder="Follows the country; change if you pay differently"
              />
            </div>
            {(
              [
                ["paymentsPerYear", "Payments a year (12–16)"],
                ["hoursPerWeek", "Hours a week"],
                ["region", "Pooling region (e.g. South Europe)"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`pz-${k}`} className="text-xs">
                  {label}
                </Label>
                <Input
                  id={`pz-${k}`}
                  value={zone[k]}
                  onChange={(e) => setZone({ ...zone, [k]: e.target.value })}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="pz-basis" className="text-xs">
                Pay usually quoted
              </Label>
              <select
                id="pz-basis"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={zone.basis}
                onChange={(e) => setZone({ ...zone, basis: e.target.value })}
              >
                {Object.entries(BASIS_WORDS).map(([k, w]) => (
                  <option key={k} value={k}>
                    {w}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button variant="outline" disabled={busy || !zoneValid} onClick={saveZone}>
            Save zone
          </Button>
        </div>
      ) : null}

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
          Exchange rates
        </h3>
        {rates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rates yet — pay in another currency is shown as said and not compared.
          </p>
        ) : (
          <ul className="text-sm">
            {rates.map((r) => (
              <li key={r.id}>
                1 {r.from} = {r.rate} {r.to}{" "}
                <span className="text-muted-foreground">
                  ({r.source}, {r.at.slice(0, 10)})
                </span>
              </li>
            ))}
          </ul>
        )}
        {canDecide ? (
          <div className="mt-2 grid items-end gap-2 sm:grid-cols-5">
            <div className="space-y-1">
              <Label htmlFor="xr-from" className="text-xs">
                From
              </Label>
              <CodeSelect
                id="xr-from"
                options={CURRENCY_OPTIONS}
                value={rate.from}
                onChange={(code) => setRate({ ...rate, from: code })}
                placeholder="Pick a currency"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="xr-to" className="text-xs">
                To
              </Label>
              <CodeSelect
                id="xr-to"
                options={CURRENCY_OPTIONS}
                value={rate.to}
                onChange={(code) => setRate({ ...rate, to: code })}
                placeholder="Pick a currency"
              />
            </div>
            {(
              [
                ["rate", "Rate"],
                ["source", "Source (e.g. Finance table)"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`xr-${k}`} className="text-xs">
                  {label}
                </Label>
                <Input
                  id={`xr-${k}`}
                  value={rate[k]}
                  inputMode={k === "rate" ? "decimal" : undefined}
                  onChange={(e) => setRate({ ...rate, [k]: e.target.value })}
                />
              </div>
            ))}
            <Button variant="outline" disabled={busy || !rateValid} onClick={saveRate}>
              Add rate
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
