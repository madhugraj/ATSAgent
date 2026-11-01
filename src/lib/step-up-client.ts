/**
 * Client side of step-up re-authentication (docs/guardrails.md P2-4).
 *
 * `withStepUp(action)` runs a server call; when the server answers that the
 * action needs a fresh password, it opens the password dialog (StepUpDialog,
 * mounted once in the root layout), and after a correct password retries the
 * call once. Cancelling leaves the action undone.
 */
const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

type Pending = { resolve: (ok: boolean) => void };
let pending: Pending | null = null;
const listeners = new Set<(open: boolean) => void>();

export function needsStepUp(e: unknown): boolean {
  return e instanceof Error && e.message.includes(STEP_UP_REQUIRED);
}

/** Open the dialog; resolves true once the password was confirmed. */
export function requestStepUp(): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { resolve };
    for (const l of listeners) l(true);
  });
}

/** Called by the dialog when it closes. */
export function finishStepUp(ok: boolean): void {
  pending?.resolve(ok);
  pending = null;
  for (const l of listeners) l(false);
}

export function onStepUpChange(l: (open: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (!needsStepUp(e)) throw e;
    if (!(await requestStepUp())) throw new Error("Cancelled — nothing was changed.");
    return action();
  }
}
