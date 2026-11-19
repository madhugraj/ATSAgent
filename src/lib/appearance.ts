/**
 * Per-device appearance preferences (theme and text size). Stored in
 * localStorage and applied to <html> by APPEARANCE_BOOT_SCRIPT before first
 * paint, so there is no flash of the wrong theme.
 */
export type Theme = "light" | "soft" | "dark" | "system";
export type TextSize = "default" | "large" | "larger";

export const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "soft", label: "Soft" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export const TEXT_SIZE_OPTIONS: { value: TextSize; label: string; scale: number }[] = [
  { value: "default", label: "Default", scale: 1 },
  { value: "large", label: "Large", scale: 1.125 },
  { value: "larger", label: "Larger", scale: 1.25 },
];

const THEME_KEY = "ats.theme";
const TEXT_KEY = "ats.textSize";

export function readAppearance(): { theme: Theme; textSize: TextSize } {
  if (typeof window === "undefined") return { theme: "light", textSize: "default" };
  const t = localStorage.getItem(THEME_KEY) as Theme | null;
  const s = localStorage.getItem(TEXT_KEY) as TextSize | null;
  return {
    theme: THEME_OPTIONS.some((o) => o.value === t) ? (t as Theme) : "light",
    textSize: TEXT_SIZE_OPTIONS.some((o) => o.value === s) ? (s as TextSize) : "default",
  };
}

export function saveAppearance(next: { theme: Theme; textSize: TextSize }) {
  localStorage.setItem(THEME_KEY, next.theme);
  localStorage.setItem(TEXT_KEY, next.textSize);
  applyAppearance(next);
}

export function applyAppearance({ theme, textSize }: { theme: Theme; textSize: TextSize }) {
  const root = document.documentElement;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("soft", resolved === "soft");
  root.style.colorScheme = resolved === "dark" ? "dark" : "light";
  const scale = TEXT_SIZE_OPTIONS.find((o) => o.value === textSize)?.scale ?? 1;
  // Root font size: every rem-based size (text, spacing) scales with it.
  root.style.fontSize = scale === 1 ? "" : `${scale * 100}%`;
}

// Inline, dependency-free twin of readAppearance + applyAppearance for <head>.
export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}")||"light",s=localStorage.getItem("${TEXT_KEY}"),r=document.documentElement;if(t==="system")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(t==="dark"||t==="soft")r.classList.add(t);r.style.colorScheme=t==="dark"?"dark":"light";var z={large:112.5,larger:125}[s];if(z)r.style.fontSize=z+"%"}catch(e){}})();`;
