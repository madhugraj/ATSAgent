import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ISO_COUNTRIES, ISO_CURRENCIES } from "@/lib/iso";
import { cn } from "@/lib/utils";

export type CodeOption = { code: string; label: string };

function toOptions(map: Readonly<Record<string, string>>): CodeOption[] {
  return Object.entries(map)
    .map(([code, label]) => ({ code, label: `${label} (${code})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Searchable single-code dropdown (ISO 4217 / ISO 3166-1 codes + names). */
export function CodeSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  id,
  className,
}: {
  options: CodeOption[];
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((o) => o.code === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className={cn("truncate", !chosen && "text-muted-foreground")}>
            {chosen?.label ?? placeholder ?? "Pick one"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or code" />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.code}
                  value={`${o.label} ${o.code}`}
                  onSelect={() => {
                    onChange(o.code);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 size-4", o.code === value ? "opacity-100" : "opacity-0")} />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const CURRENCY_OPTIONS = toOptions(ISO_CURRENCIES);
export const COUNTRY_OPTIONS = toOptions(ISO_COUNTRIES);

/** Searchable multi-select for country codes; selected codes show as removable badges. */
export function CountryMultiSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const options = COUNTRY_OPTIONS;
  const pick = (code: string) =>
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {value.length === 0
                ? "Pick countries"
                : `${value.length} countr${value.length === 1 ? "y" : "ies"} selected`}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search by name or code" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.code} value={`${o.label} ${o.code}`} onSelect={() => pick(o.code)}>
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        value.includes(o.code) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((c) => (
            <Badge key={c} variant="secondary" className="gap-1 pr-1">
              {c}
              <button
                type="button"
                aria-label={`Remove ${c}`}
                disabled={disabled}
                onClick={() => pick(c)}
                className="rounded-sm p-0.5 hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
