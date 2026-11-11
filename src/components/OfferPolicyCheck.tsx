import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getOfferCheck, overrideOfferCheck, runOfferCheck } from "@/lib/offer-check.functions";

const VERDICT: Record<string, { label: string; cls: string }> = {
  pass: { label: "Passed", cls: "text-emerald-700 dark:text-emerald-400" },
  fix_needed: { label: "Fix needed", cls: "text-red-700 dark:text-red-400" },
  needs_counsel: { label: "Needs counsel", cls: "text-amber-700 dark:text-amber-400" },
};

/**
 * The offer check against the organisation's approved labour rules for the role's
 * pay zone. It also runs on its own when the offer is sent for approval; a fix
 * needed blocks that until the letter is fixed or the HR head overrides it.
 */
export function OfferPolicyCheck({ offerId, hasLetter }: { offerId: string; hasLetter: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["offer_check", offerId],
    queryFn: () => getOfferCheck({ data: { offerId } }),
  });
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  if (!q.data) return null;
  const { check, stale, override, canOverride } = q.data;

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      qc.invalidateQueries({ queryKey: ["offer_check", offerId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not run the check");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 rounded-md border p-3 text-sm" aria-label="Offer check">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <Scale className="size-4" /> Labour rules check
          {check ? (
            <span className={VERDICT[check.verdict]?.cls}>
              — {VERDICT[check.verdict]?.label}
              {stale ? " (out of date)" : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">— not run yet</span>
          )}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !hasLetter}
          onClick={() => act(() => runOfferCheck({ data: { offerId } }), "Checked.")}
        >
          {check ? "Check again" : "Check against labour rules"}
        </Button>
      </div>
      {check ? (
        <ul className="space-y-1">
          {check.items.map((i, n) => (
            <li key={n}>
              <span className={VERDICT[i.verdict]?.cls}>{VERDICT[i.verdict]?.label}</span> ·{" "}
              {i.check}: {i.detail}
              {i.suggestion ? (
                <span className="block text-xs text-muted-foreground">
                  Suggested wording: {i.suggestion}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Checks the letter and terms against your approved labour rules for this role&apos;s pay
          zone. It also runs when the offer is sent for approval. Not legal advice.
        </p>
      )}
      {override ? (
        <p className="text-xs">
          Overridden by {override.by}: “{override.reason}”
        </p>
      ) : check?.verdict === "fix_needed" && !stale && canOverride ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="Why the offer may go ahead as it is"
            placeholder="Why the offer may go ahead as it is (HR head)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="max-w-md"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || reason.trim().length < 10}
            onClick={() =>
              act(
                () => overrideOfferCheck({ data: { offerId, reason: reason.trim() } }),
                "Overridden — recorded in the audit log.",
              )
            }
          >
            Override
          </Button>
        </div>
      ) : null}
    </section>
  );
}
