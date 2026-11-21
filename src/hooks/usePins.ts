import { useCallback, useEffect, useState } from "react";

const KEY = "atsiq.pins";
/** Enough for a person's daily pages without turning the pinned row into a second menu. */
export const MAX_PINS = 6;

/** Pages pinned to the top of the sidebar, remembered per browser. */
export function usePins() {
  const [pins, setPins] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
      if (Array.isArray(saved)) setPins(saved.filter((p): p is string => typeof p === "string"));
    } catch {
      // A corrupt entry just means no pins.
    }
  }, []);
  const toggle = useCallback((key: string) => {
    setPins((cur) => {
      const next = cur.includes(key)
        ? cur.filter((k) => k !== key)
        : [...cur, key].slice(-MAX_PINS);
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [pins, toggle] as const;
}
