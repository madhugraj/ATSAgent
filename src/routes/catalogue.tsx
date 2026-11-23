import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Search } from "lucide-react";

import {
  readCatalogue,
  saveCatalogueCommercials,
  type CatalogueRow,
} from "@/lib/catalogue.functions";
import { CATALOGUE_SUMMARY, CATALOGUE_TIERS, totalCapabilities } from "@/lib/product-catalogue";
import { downloadCataloguePdf, downloadCatalogueXlsx } from "@/lib/catalogue-export";
import { usePlatform } from "@/hooks/usePlatform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/catalogue")({
  head: () => ({
    meta: [
      { title: "Product catalogue — ATSIQ modules, capabilities & commercials" },
      {
        name: "description",
        content:
          "Product-owner catalogue of every ATSIQ module, the capabilities inside it, who it serves and its commercial terms, downloadable as PDF or Excel.",
      },
      { property: "og:title", content: "ATSIQ product catalogue" },
      {
        property: "og:description",
        content:
          "Live module and capability catalogue with editable commercial terms, exportable to PDF and Excel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Catalogue,
});

function Catalogue() {
  const { isSuperUser, isLoading: loadingRole } = usePlatform();
  const fetchCatalogue = useServerFn(readCatalogue);
  const cat = useQuery({
    queryKey: ["product_catalogue"],
    queryFn: () => fetchCatalogue({}),
    enabled: isSuperUser,
  });

  const [q, setQ] = useState("");
  const [tier, setTier] = useState("all");

  const rows = useMemo(() => {
    const list = cat.data?.modules ?? [];
    const needle = q.trim().toLowerCase();
    return list.filter((m) => {
      if (tier !== "all" && m.commercials.tier !== tier) return false;
      if (!needle) return true;
      return (
        m.name.toLowerCase().includes(needle) ||
        m.category.toLowerCase().includes(needle) ||
        m.audience.toLowerCase().includes(needle) ||
        m.summary.toLowerCase().includes(needle) ||
        m.overview.toLowerCase().includes(needle) ||
        m.capabilities.some((c) => `${c.name} ${c.detail}`.toLowerCase().includes(needle))
      );
    });
  }, [cat.data, q, tier]);

  if (loadingRole)
    return <p className="p-6 text-sm text-muted-foreground">Checking your access…</p>;
  if (!isSuperUser) {
    return (
      <div className="p-6">
        <h1 className="font-display text-xl">Product catalogue</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          The product catalogue is available to the product owner only. Ask the super admin if you
          need a copy for a client conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[0.6875rem] font-mono uppercase tracking-widest text-primary">
            Product owner
          </p>
          <h1 className="font-display text-2xl">Product catalogue</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {CATALOGUE_SUMMARY.positioning}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!cat.data}
            onClick={() => cat.data && downloadCatalogueXlsx(cat.data)}
          >
            <FileSpreadsheet className="mr-2 size-4" /> Excel
          </Button>
          <Button disabled={!cat.data} onClick={() => cat.data && downloadCataloguePdf(cat.data)}>
            <Download className="mr-2 size-4" /> PDF
          </Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="Modules" value={String(cat.data?.modules.length ?? 0)} />
        <Figure label="Capabilities" value={String(totalCapabilities())} />
        <Figure
          label="Generated"
          value={cat.data ? new Date(cat.data.generatedAt).toLocaleString() : "…"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="w-72 pl-8"
            placeholder="Search modules and capabilities"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={tier} onValueChange={setTier}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            {CATALOGUE_TIERS.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{rows.length} shown</span>
      </div>

      {cat.isLoading ? (
        <p className="text-sm text-muted-foreground">Building the catalogue…</p>
      ) : null}
      {cat.error ? (
        <p className="text-sm text-destructive">{(cat.error as Error).message}</p>
      ) : null}

      <div className="space-y-4">
        {rows.map((m) => (
          <ModuleCard key={m.id} m={m} />
        ))}
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-[0.6875rem] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate font-display text-lg">{value}</p>
    </div>
  );
}

function ModuleCard({ m }: { m: CatalogueRow }) {
  const qc = useQueryClient();
  const save = useServerFn(saveCatalogueCommercials);
  const [edit, setEdit] = useState(false);
  const [tier, setTier] = useState(m.commercials.tier);
  const [currency, setCurrency] = useState(m.commercials.currency);
  const [priceText, setPriceText] = useState(
    m.commercials.listPrice === null ? "" : String(m.commercials.listPrice),
  );
  const [unit, setUnit] = useState(m.commercials.unit);
  const [notes, setNotes] = useState(m.commercials.notes);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const trimmed = priceText.trim();
    const listPrice = trimmed === "" ? null : Number(trimmed);
    if (listPrice !== null && !Number.isFinite(listPrice)) {
      toast.error("List price must be a number, or empty for “on request”.");
      return;
    }
    setBusy(true);
    try {
      await save({
        data: { moduleId: m.id, tier, currency, listPrice, unit, notes },
      });
      await qc.invalidateQueries({ queryKey: ["product_catalogue"] });
      setEdit(false);
      toast.success("Commercial terms saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg">{m.name}</h2>
            <Badge variant="secondary">{m.category}</Badge>
            <Badge>{m.commercials.tier}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{m.audience}</p>
          <p className="mt-2 max-w-3xl text-sm">{m.summary}</p>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Outcome: {m.outcome}</p>
        </div>
        <div className="text-right">
          <p className="font-display text-base">
            {m.commercials.listPrice === null
              ? "On request"
              : `${m.commercials.currency} ${m.commercials.listPrice.toLocaleString()}`}
          </p>
          <p className="text-xs text-muted-foreground">{m.commercials.unit}</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => setEdit((v) => !v)}>
            {edit ? "Close" : "Edit commercials"}
          </Button>
        </div>
      </div>

      <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {m.capabilities.map((c) => (
          <li key={c.name} className="flex gap-2 text-sm">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
            <span>
              <span className="font-medium">{c.name}</span>
              <span className="text-muted-foreground"> — {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {m.commercials.notes && !edit ? (
        <p className="mt-3 rounded-md bg-muted/60 p-3 text-sm">{m.commercials.notes}</p>
      ) : null}

      {edit ? (
        <div className="mt-4 grid gap-3 rounded-md border p-4 sm:grid-cols-5">
          <label className="text-xs">
            Tier
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATALOGUE_TIERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="text-xs">
            Currency
            <Input
              className="mt-1"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </label>
          <label className="text-xs">
            List price
            <Input
              className="mt-1"
              placeholder="Empty = on request"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
            />
          </label>
          <label className="text-xs sm:col-span-2">
            Unit
            <Input className="mt-1" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </label>
          <label className="text-xs sm:col-span-5">
            Packaging / commercial notes
            <Input className="mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="sm:col-span-5">
            <Button size="sm" disabled={busy} onClick={commit}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
