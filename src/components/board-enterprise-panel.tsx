/**
 * Enterprise-connection checklist for one partner board inside its
 * Integrations card: credentials → connection test → webhook delivery URL →
 * what the contract actually opens (capabilities) → live postings and
 * applications. Deliberately honest: a board whose partner pack has not
 * landed shows a "pending" line, never a fake green tick.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Check, CircleDashed, Copy, KeyRound, Loader2, RefreshCw, X } from "lucide-react";

import {
  boardIntegrationSummary,
  boardWebhookSetup,
  boardWebhookUrl,
} from "@/lib/boards.functions";
import { Button } from "@/components/ui/button";

type Summary = Awaited<ReturnType<typeof boardIntegrationSummary>>;

type CheckState = "ok" | "pending" | "missing";

function CheckRow({
  state,
  label,
  detail,
}: {
  state: CheckState;
  label: string;
  detail?: string | null | undefined;
}) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {state === "ok" ? (
        <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : state === "pending" ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  );
}

export function BoardEnterprisePanel({
  provider,
  integrationId,
  enabled,
  hasCredentials,
  lastTestStatus,
  lastTestMessage,
}: {
  provider: "linkedin" | "indeed" | "naukri";
  integrationId: string;
  enabled: boolean;
  hasCredentials: boolean;
  lastTestStatus: string;
  lastTestMessage: string | null;
}) {
  const runRotate = useServerFn(boardWebhookSetup);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const summary = useQuery({
    queryKey: ["board_summary", provider],
    queryFn: () => boardIntegrationSummary(),
    enabled: integrationId !== "",
  });
  const webhook = useQuery({
    queryKey: ["board_webhook_url", provider],
    queryFn: () => boardWebhookUrl({ data: { provider } }),
  });

  const s = (summary.data as Summary | undefined)?.[provider] as
    | { postingsLive: number; applicationsReceived: number; lastApplicationAt: string | null }
    | undefined;
  const webhookUrl = webhook.data?.webhookUrl ?? null;

  async function rotate() {
    setBusy(true);
    try {
      const res = (await runRotate({ data: { provider } })) as { webhookUrl: string };
      await qc.invalidateQueries({ queryKey: ["board_webhook_url", provider] });
      await navigator.clipboard.writeText(res.webhookUrl);
      toast.success("Webhook URL rotated and copied to your clipboard");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rotate the webhook URL");
    } finally {
      setBusy(false);
    }
  }

  const credentialState: CheckState = hasCredentials ? "ok" : "missing";
  const testState: CheckState =
    lastTestStatus === "ok" ? "ok" : lastTestStatus === "failed" ? "missing" : "pending";
  const webhookState: CheckState = webhook.isLoading ? "pending" : webhookUrl ? "ok" : "missing";

  return (
    <div
      className="mt-4 rounded-xl border border-border bg-surface-2 p-3"
      data-testid={`board-panel-${provider}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Enterprise connection
      </p>
      <ul className="mt-2 grid gap-2">
        <CheckRow
          state={credentialState}
          label={hasCredentials ? "Credentials stored" : "Credentials missing"}
          detail={
            hasCredentials ? undefined : "Paste the partner credentials below and press Save."
          }
        />
        <CheckRow
          state={testState}
          label={lastTestStatus === "ok" ? "Connection test passed" : "Connection test pending"}
          detail={lastTestMessage ?? undefined}
        />
        {provider !== "linkedin" && (
          <li className="grid gap-1.5">
            <div className="flex items-start gap-2 text-sm">
              {webhookState === "ok" ? (
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : webhookState === "pending" ? (
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {webhookUrl ? "Application webhook live" : "Application webhook not set up"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {webhookUrl
                    ? "Give this exact URL to the board (Indeed: apply endpoint; Naukri: callback URL)."
                    : "Generate your delivery URL, then register it with the board."}
                </span>
              </span>
              <Button
                size="sm"
                variant={webhookUrl ? "ghost" : "outline"}
                onClick={rotate}
                disabled={busy}
                title={
                  webhookUrl
                    ? "Generate a new URL — the old one stops working"
                    : "Generate the delivery URL"
                }
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : webhookUrl ? (
                  <RefreshCw className="size-3.5" />
                ) : (
                  <KeyRound className="size-3.5" />
                )}
                {webhookUrl ? "Rotate" : "Set up"}
              </Button>
            </div>
            {webhookUrl && (
              <div className="ml-6 flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-[0.6875rem]">
                  {webhookUrl}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-7 p-0"
                  onClick={async () => {
                    await navigator.clipboard.writeText(webhookUrl);
                    toast.success("Webhook URL copied");
                  }}
                  title="Copy URL"
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            )}
          </li>
        )}
        {s && (
          <CheckRow
            state={s.applicationsReceived > 0 ? "ok" : "pending"}
            label={`${s.postingsLive} posting(s) live · ${s.applicationsReceived} application(s) delivered`}
            detail={
              s.lastApplicationAt
                ? `Last delivery ${new Date(s.lastApplicationAt).toLocaleString()}`
                : "No applications delivered through this connection yet."
            }
          />
        )}
        <CheckRow
          state={enabled ? "ok" : "missing"}
          label={enabled ? "Connection enabled" : "Connection switched off"}
          detail={
            enabled ? undefined : "Switch the connection on above before publishing to this board."
          }
        />
      </ul>
    </div>
  );
}
