import { useCallback, useEffect, useState } from "react";

import type { WorkMode } from "@/components/nav-config";
import { useMe } from "./useMe";

const EVENT = "atsiq:work-mode";
const keyFor = (userId: string | null) => `atsiq.mode.${userId ?? "anonymous"}`;
const valid = (v: unknown): v is WorkMode => v === "agent" || v === "manual";

/**
 * Agent mode or Manual mode — which half of the menu a person sees. Remembered
 * per user in this browser; agent mode is the default. Every component using
 * the hook stays in step (same tab via an event, other tabs via `storage`).
 */
export function useWorkMode(): [WorkMode, (mode: WorkMode) => void, boolean] {
  const { userId } = useMe();
  const [mode, setState] = useState<WorkMode>("agent");
  /** True once the saved choice has been read (false during the first render). */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The saved choice is per user: wait until we know who is signed in.
    if (!userId) return;
    const saved = localStorage.getItem(keyFor(userId));
    if (valid(saved)) setState(saved);
    setReady(true);
    const onLocal = (e: Event) => {
      const next = (e as CustomEvent<WorkMode>).detail;
      if (valid(next)) setState(next);
    };
    const onOtherTab = (e: StorageEvent) => {
      if (e.key === keyFor(userId) && valid(e.newValue)) setState(e.newValue);
    };
    window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onOtherTab);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onOtherTab);
    };
  }, [userId]);

  const setMode = useCallback(
    (next: WorkMode) => {
      localStorage.setItem(keyFor(userId), next);
      setState(next);
      window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
    },
    [userId],
  );

  return [mode, setMode, ready];
}
