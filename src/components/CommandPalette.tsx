import { useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Loader2, Search, Users } from "lucide-react";

import { globalSearchQuery } from "@/lib/data";
import { NAV_GROUPS } from "@/components/nav-config";
import { useNavCtx } from "@/hooks/useNavCtx";
import { StatusBadge } from "@/components/ats";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * ⌘K global search: jump to any page, candidate or requisition. Server-side
 * filtering (globalSearch) is redaction-aware; the palette only renders what
 * the caller is allowed to see.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const ctx = useNavCtx();

  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 200);
    return () => clearTimeout(t);
  }, [term]);

  // Cmd/Ctrl+K toggles from anywhere; sidebar.tsx:96 is the precedent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const active = open && ctx.inOrg && debounced.trim().length >= 2;
  const q = useQuery({
    ...globalSearchQuery(debounced),
    enabled: active,
  });
  const results = active ? q.data : undefined;

  function go(dest: string) {
    onOpenChange(false);
    setTerm("");
    setDebounced("");
    router.history.push(dest);
  }

  const navItems = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.show(ctx));
  const showResults = active && (results !== undefined || q.isFetching);
  const resultCount = (results?.candidates.length ?? 0) + (results?.requisitions.length ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Global search</DialogTitle>
        <Command shouldFilter={false} className="flex flex-col">
          <CommandInput
            value={term}
            onValueChange={setTerm}
            placeholder="Search candidates, requisitions, pages…"
          />
          <CommandList className="max-h-[70vh]">
            {navItems.length ? (
              <CommandGroup heading="Go to">
                {navItems.map((item) => {
                  const dest = item.search
                    ? `${item.to}?${new URLSearchParams(item.search)}`
                    : item.to;
                  return (
                    <CommandItem
                      key={dest}
                      value={`nav ${item.label} ${dest}`}
                      onSelect={() => go(dest)}
                    >
                      <item.icon className="text-muted-foreground" />
                      {item.label}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}

            {ctx.recruiterView ? (
              <CommandGroup heading="Actions">
                <CommandItem value="action raise requisition" onSelect={() => go("/requisitions")}>
                  <Users className="text-muted-foreground" />
                  Raise requisition
                </CommandItem>
                <CommandItem value="action run matching" onSelect={() => go("/matching")}>
                  <Users className="text-muted-foreground" />
                  Run JD ↔ CV matching
                </CommandItem>
                <CommandItem value="action screening queue" onSelect={() => go("/screening")}>
                  <Users className="text-muted-foreground" />
                  Open the screening queue
                </CommandItem>
              </CommandGroup>
            ) : null}

            {showResults && q.isFetching ? (
              <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Searching…
              </div>
            ) : null}

            {results?.candidates.length ? (
              <CommandGroup heading="Candidates">
                {results.candidates.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`cand ${c.full_name} ${c.email ?? ""} ${c.location ?? ""}`}
                    onSelect={() => go(`/candidates/${c.id}`)}
                  >
                    <Users className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{c.full_name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {c.via_partner_pool ? "via partner pool" : (c.email ?? c.location ?? "")}
                        {c.experience_years ? ` · ${c.experience_years} yrs` : ""}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {results?.requisitions.length ? (
              <CommandGroup heading="Requisitions">
                {results.requisitions.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={`req ${r.code} ${r.title}`}
                    onSelect={() => go(`/requisitions/${r.id}`)}
                  >
                    <span className="num text-xs text-muted-foreground">{r.code}</span>
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    <StatusBadge status={r.status} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {active && !q.isFetching && resultCount === 0 ? (
              <p className="px-3 py-2.5 text-sm text-muted-foreground">
                No candidates or requisitions match “{debounced.trim()}”.
              </p>
            ) : null}
          </CommandList>
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            ↑↓ navigate · ↵ open · esc close
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
