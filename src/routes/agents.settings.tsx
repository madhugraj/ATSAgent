import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDownRight, ArrowUpRight, PauseCircle, Radio } from "lucide-react";

import { PageHeader } from "@/components/ats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AGENT_CATALOG, AUTONOMY_OPTIONS, WHITELISTABLE_TEMPLATES } from "@/lib/agents.catalog";
import {
  agentSettings,
  saveAgentPolicy,
  type AgentPolicyInput,
  type AgentSettingsView,
} from "@/lib/agents.functions";
import {
  agentTelemetry,
  saveAgentTelemetry,
  testAgentTelemetry,
  type AgentTelemetryView,
} from "@/lib/agents-telemetry.functions";

export const Route = createFileRoute("/agents/settings")({
  head: () => ({
    meta: [
      { title: "Agent settings — ATSIQ" },
      {
        name: "description",
        content: "How much each hiring agent may do on its own in this organisation.",
      },
    ],
  }),
  component: AgentSettingsPage,
});

type Row = AgentSettingsView["agents"][number];

function AgentSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent_settings"], queryFn: () => agentSettings() });
  const data = q.data;

  async function save(input: AgentPolicyInput) {
    try {
      await saveAgentPolicy({ data: input });
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["agent_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Agent settings"
        description="Agents are off until you switch them on. Choose how much each hiring agent may do on its own. Approving requisitions, JDs and offers, releasing offers, rejecting candidates and hiring decisions always stay with people, whatever you set here."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/agents">Agent decisions</Link>
          </Button>
        }
      />

      {q.isLoading || !data ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {!data.canEdit ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Only the HR head, President / CBO or the account owner can change these settings.
            </p>
          ) : null}

          <section className="panel mt-4 flex flex-wrap items-center gap-3 p-5">
            <PauseCircle className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Pause all agents</p>
              <p className="text-sm text-muted-foreground">
                Stops every agent in this organisation from picking up work. Runs already waiting
                for a person stay where they are.
              </p>
            </div>
            <Switch
              checked={data.allPaused}
              disabled={!data.canEdit}
              onCheckedChange={(paused) => save({ agentType: "*", enabled: !paused })}
            />
          </section>

          <div className="mt-4 space-y-3">
            {AGENT_CATALOG.map((info) => {
              const row = data.agents.find((a) => a.type === info.type);
              return row ? (
                <AgentRow
                  key={info.type}
                  info={info}
                  row={row}
                  canEdit={data.canEdit}
                  onSave={save}
                />
              ) : null;
            })}
          </div>

          <TelemetrySection />
        </>
      )}
    </>
  );
}

function AgentRow({
  info,
  row,
  canEdit,
  onSave,
}: {
  info: (typeof AGENT_CATALOG)[number];
  row: Row;
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
}) {
  const [budget, setBudget] = useState(row.monthlyTokenBudget?.toString() ?? "");
  const hint = AUTONOMY_OPTIONS.find((o) => o.value === row.autonomy)?.hint;
  const base = {
    agentType: row.type,
    enabled: row.enabled,
    autonomy: row.autonomy,
    whitelistedTemplates: row.whitelistedTemplates,
  };

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{info.label}</h3>
        {row.live ? (
          <Badge>Live</Badge>
        ) : (
          <Badge variant="outline">Not live yet — arrives in phase {info.phase}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`en-${row.type}`} className="text-xs text-muted-foreground">
            Enabled
          </Label>
          <Switch
            id={`en-${row.type}`}
            checked={row.enabled}
            disabled={!canEdit || !row.live}
            onCheckedChange={(enabled) => onSave({ ...base, enabled })}
          />
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{info.description}</p>

      {row.recommendation && row.enabled ? (
        <Recommendation row={row} canEdit={canEdit} onSave={onSave} base={base} />
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <Label className="text-xs">Autonomy</Label>
          <Select
            value={row.autonomy}
            disabled={!canEdit}
            onValueChange={(v) => onSave({ ...base, autonomy: v as Row["autonomy"] })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>

        <div>
          {(["email", "board"] as const)
            .filter((g) => g === "email" || row.type === "publishing")
            .map((group) => (
              <div key={group} className={group === "board" ? "mt-3" : ""}>
                <Label className="text-xs">
                  {group === "email" ? "Pre-approved candidate emails" : "Pre-approved job boards"}
                </Label>
                <div className="mt-2 space-y-1.5">
                  {WHITELISTABLE_TEMPLATES.filter((t) => t.group === group).map((t) => {
                    const on = row.whitelistedTemplates.includes(t.id);
                    return (
                      <label key={t.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={on}
                          disabled={!canEdit}
                          onCheckedChange={(v) =>
                            onSave({
                              ...base,
                              whitelistedTemplates: v
                                ? [...row.whitelistedTemplates, t.id]
                                : row.whitelistedTemplates.filter((x) => x !== t.id),
                            })
                          }
                        />
                        {t.label}
                      </label>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {group === "email"
                    ? "Used at Act and notify. At Autonomous every candidate email template sends on its own."
                    : "Used at Autonomous only. Otherwise every post goes to the HR head for approval, and is published as that HR head."}
                </p>
              </div>
            ))}
        </div>

        <div>
          <Label className="text-xs" htmlFor={`budget-${row.type}`}>
            Monthly token budget
          </Label>
          <div className="mt-1 flex gap-2">
            <Input
              id={`budget-${row.type}`}
              inputMode="numeric"
              placeholder="No limit"
              value={budget}
              disabled={!canEdit}
              onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() =>
                onSave({ ...base, monthlyTokenBudget: budget ? Number(budget) : null })
              }
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Leave empty for no limit.</p>
        </div>
      </div>
    </section>
  );
}

const LEVEL_LABEL: Record<string, string> = Object.fromEntries(
  AUTONOMY_OPTIONS.map((o) => [o.value, o.label]),
);
const TEMPLATE_LABEL: Record<string, string> = Object.fromEntries(
  WHITELISTABLE_TEMPLATES.map((t) => [t.id, t.label]),
);

/** Measured autonomy recommendation (30 days). Only a person applies it. */
function Recommendation({
  row,
  canEdit,
  onSave,
  base,
}: {
  row: Row;
  canEdit: boolean;
  onSave: (input: AgentPolicyInput) => Promise<void>;
  base: AgentPolicyInput;
}) {
  const r = row.recommendation!;
  const s = r.stats;
  const tone =
    r.action === "lower"
      ? "border-destructive/40 bg-destructive/5"
      : r.action === "raise"
        ? "border-primary/40 bg-primary/5"
        : "border-border bg-muted/30";
  return (
    <div className={`mt-3 rounded-md border p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        {r.action === "raise" ? (
          <ArrowUpRight className="size-4 text-primary" />
        ) : r.action === "lower" ? (
          <ArrowDownRight className="size-4 text-destructive" />
        ) : null}
        <span className="font-medium">
          {r.action === "raise"
            ? `Recommended: raise to ${LEVEL_LABEL[r.to!]}`
            : r.action === "lower"
              ? `Recommended: lower to ${LEVEL_LABEL[r.to!]}`
              : "Recommendation: keep the current level"}
        </span>
        {r.to && canEdit ? (
          <Button
            size="sm"
            variant={r.action === "lower" ? "destructive" : "default"}
            className="ml-auto h-7"
            onClick={() => onSave({ ...base, autonomy: r.to!, viaRecommendation: true })}
          >
            Apply
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-muted-foreground">{r.reason}</p>
      <p className="num mt-1 text-xs text-muted-foreground">
        Last 30 days: {s.decided} decided request(s) · {s.approvedUnedited} approved unchanged ·{" "}
        {s.edited} edited · {s.rejected} rejected · {s.notifiedActions} reported action(s) ·{" "}
        {s.toolErrors}/{s.toolCalls} tool errors · {s.runsFailed}/{s.runsFinished} failed runs
        {s.daysAtLevel !== null ? ` · ${s.daysAtLevel} day(s) at this level` : ""}
      </p>
      {r.templates.map((t) => (
        <div key={t.id} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>
            <span className="font-medium">{TEMPLATE_LABEL[t.id] ?? t.id}</span> was approved
            unchanged {t.approvedUnedited} of {t.decided} times — consider pre-approving it.
          </span>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6"
              onClick={() =>
                onSave({
                  ...base,
                  whitelistedTemplates: [...row.whitelistedTemplates, t.id],
                  viaRecommendation: true,
                })
              }
            >
              Pre-approve
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Trace export to the org's own OpenTelemetry collector, and alert channels. */
function TelemetrySection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent_telemetry"], queryFn: () => agentTelemetry() });
  const t = q.data;
  if (!t) return null;
  return (
    <TelemetryForm
      key={JSON.stringify(t)}
      t={t}
      onSaved={() => qc.invalidateQueries({ queryKey: ["agent_telemetry"] })}
    />
  );
}

function TelemetryForm({ t, onSaved }: { t: AgentTelemetryView; onSaved: () => void }) {
  const [otlpEnabled, setOtlpEnabled] = useState(t.otlpEnabled);
  const [endpoint, setEndpoint] = useState(t.otlpEndpoint ?? "");
  const [headers, setHeaders] = useState("");
  const [emailOn, setEmailOn] = useState(t.alertEmailEnabled);
  const [webhook, setWebhook] = useState(t.alertWebhookUrl ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    let parsedHeaders: Record<string, string> | undefined;
    if (headers.trim()) {
      try {
        parsedHeaders = Object.fromEntries(
          headers
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const i = l.indexOf(":");
              if (i < 1) throw new Error(l);
              return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
            }),
        );
      } catch {
        toast.error("Write one header per line as Name: value");
        return;
      }
    }
    setBusy(true);
    try {
      await saveAgentTelemetry({
        data: {
          otlpEnabled,
          otlpEndpoint: endpoint.trim() || null,
          ...(parsedHeaders ? { otlpHeaders: parsedHeaders } : {}),
          alertEmailEnabled: emailOn,
          alertWebhookUrl: webhook.trim() || null,
          ...(secret.trim() ? { alertWebhookSecret: secret.trim() } : {}),
        },
      });
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function test(target: "otlp" | "webhook") {
    setBusy(true);
    try {
      const r = await testAgentTelemetry({ data: { target } });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  const disabled = !t.canEdit || busy;
  return (
    <section className="panel mt-6 p-5">
      <div className="flex items-center gap-2">
        <Radio className="size-4 text-primary" />
        <h3 className="font-semibold">Trace export and alerts</h3>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Send each finished agent run to your own OpenTelemetry collector as a trace (ids, steps,
        timings and token counts only — no candidate content or prompts), and choose how serious and
        critical agent health issues reach you besides the notification bell.
      </p>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              id="otlp-on"
              checked={otlpEnabled}
              disabled={disabled}
              onCheckedChange={setOtlpEnabled}
            />
            <Label htmlFor="otlp-on">Export traces (OTLP/HTTP JSON)</Label>
          </div>
          <div>
            <Label className="text-xs" htmlFor="otlp-endpoint">
              Collector traces address
            </Label>
            <Input
              id="otlp-endpoint"
              className="mt-1"
              placeholder="https://collector.example.com/v1/traces"
              value={endpoint}
              disabled={disabled}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="otlp-headers">
              Headers (one per line, Name: value){" "}
              {t.otlpHeaderNames.length ? `— saved: ${t.otlpHeaderNames.join(", ")}` : ""}
            </Label>
            <textarea
              id="otlp-headers"
              className="mt-1 min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
              placeholder={
                t.otlpHeaderNames.length ? "Leave empty to keep the saved headers" : "x-api-key: …"
              }
              value={headers}
              disabled={disabled}
              onChange={(e) => setHeaders(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Stored encrypted and never shown again.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t.lastExportError
              ? `Last attempt failed: ${t.lastExportError}`
              : t.lastExportAt
                ? `Last export ${new Date(t.lastExportAt).toLocaleString()}`
                : "Nothing exported yet."}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !t.otlpEndpoint}
            onClick={() => test("otlp")}
          >
            Send a test trace
          </Button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              id="alert-email"
              checked={emailOn}
              disabled={disabled}
              onCheckedChange={setEmailOn}
            />
            <Label htmlFor="alert-email">E-mail the owner, HR heads and CBOs</Label>
          </div>
          <div>
            <Label className="text-xs" htmlFor="alert-webhook">
              Alert webhook (optional — e.g. your paging or chat tool)
            </Label>
            <Input
              id="alert-webhook"
              className="mt-1"
              placeholder="https://hooks.example.com/…"
              value={webhook}
              disabled={disabled}
              onChange={(e) => setWebhook(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="alert-secret">
              Signing secret{" "}
              {t.hasWebhookSecret ? "(saved — enter a new one to replace it)" : "(16+ characters)"}
            </Label>
            <Input
              id="alert-secret"
              className="mt-1"
              type="password"
              autoComplete="off"
              value={secret}
              disabled={disabled}
              onChange={(e) => setSecret(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Each call carries <code>X-ATSAgent-Signature: sha256=…</code> (HMAC of the body).
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !t.alertWebhookUrl}
            onClick={() => test("webhook")}
          >
            Send a test alert
          </Button>
        </div>
      </div>

      {t.canEdit ? (
        <div className="mt-4 flex justify-end">
          <Button disabled={busy} onClick={save}>
            Save
          </Button>
        </div>
      ) : null}
    </section>
  );
}
