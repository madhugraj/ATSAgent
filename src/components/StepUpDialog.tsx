import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { finishStepUp, onStepUpChange } from "@/lib/step-up-client";
import { confirmPassword } from "@/lib/step-up.functions";

/**
 * Password prompt before a high-impact action (offer release, bulk rejection).
 * Mounted once in the root layout; opened by withStepUp(). docs/guardrails.md P2-4.
 */
export function StepUpDialog() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onStepUpChange((o) => {
        setOpen(o);
        if (o) {
          setPassword("");
          setError(null);
        }
      }),
    [],
  );

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await confirmPassword({ data: { password } });
      setPassword("");
      finishStepUp(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm your password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : finishStepUp(false))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Confirm it&apos;s you
          </DialogTitle>
          <DialogDescription>
            Releasing an offer or rejecting several candidates at once needs your password. You
            won&apos;t be asked again for 10 minutes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) void confirm();
          }}
        >
          <Label htmlFor="step-up-password">Password</Label>
          <Input
            id="step-up-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => finishStepUp(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
