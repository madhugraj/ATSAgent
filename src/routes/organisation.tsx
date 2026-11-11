import { Link, useNavigate } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Archive,
  Bot,
  Building2,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Coins,
  ListChecks,
  Phone,
  Scale,
  ScrollText,
} from "lucide-react";

import {
  archiveOwnOrganization,
  listMembers,
  updateOrganization,
} from "@/lib/org.functions";
import { getAiSettings } from "@/lib/ai-settings.functions";
import { getOrgProfileGate } from "@/lib/org-profile.functions";
import { getPaySettings } from "@/lib/pay-settings.functions";
import { getLabourPolicy } from "@/lib/labour-policy.functions";
import { getAssessmentPolicy } from "@/lib/nudges.functions";
import { getPhoneScreening } from "@/lib/phone-screening.functions";
import { getPanelAgent } from "@/lib/panel-agent.functions";
import { getTrainingStatus } from "@/lib/training.functions";
import { useOrg } from "@/hooks/useOrg";
import { useNavCtx } from "@/hooks/useNavCtx";
import { PageHeader } from "@/components/ats";
import { CodeSelect, CURRENCY_OPTIONS } from "@/components/code-select";
import { TrainingDataCard } from "@/components/TrainingDataCard";
import { AssessmentPolicyCard } from "@/components/AssessmentPolicyCard";
import { PhoneScreeningCard } from "@/components/PhoneScreeningCard";
import { PayConventionsCard } from "@/components/PayConventionsCard";
import { LabourPolicyCard } from "@/components/LabourPolicyCard";
import { SilentPanelCard } from "@/components/SilentPanelCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/organisation")({
  validateSearch: (search: Record<string, unknown>): { tab?: string | undefined } => ({
    tab: typeof search["tab"] === "string" ? (search["tab"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Organisation profile & lifecycle — Talent Acquisition" },
      {
        name: "description",
        content:
          "Owner settings: edit the organisation profile, currency and fiscal year, and archive the organisation while preserving every hiring record.",
      },
      { property: "og:title", content: "Organisation profile & lifecycle" },
      {
        property: "og:description",
        content: "Edit organisation details or archive the tenant as its owner.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OrganisationSettings,
});

const TABS = [
  { id: "identity", label: "Identity", icon: Building2 },
  { id: "pay", label: "Pay", icon: Coins },
  { id: "rules", label: "Rules & policy", icon: Scale },
  { id: "ai", label: "AI & calls", icon: Bot },
  { id: "lifecycle", label: "Lifecycle", icon: Archive },
] as const;

type TabId = (typeof TABS)[number]["id"];

function tabId(t: string | undefined): TabId {
  return (TABS.find((x) => x.id === t)?.id ?? "identity") as TabId;
}

/** One collapsible setting: closed it shows its state in one line; open, the form. */
function SettingsRow({
  icon,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <button
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent/30"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block truncate text-xs text-muted-foreground sm:hidden">
            {summary}
          </span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:block">{summary}</span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? <div className="border-t p-4">{children}</div> : null}
    </section>
  );
}

function OrganisationSettings() {
  const qc = useQueryClient();
  const { org, isOwner, isLoading, refetch } = useOrg();
  const navCtx = useNavCtx();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const tab = tabId(search.tab);
  const setTab = (t: TabId) => navigate({ to: "/organisation", search: { tab: t }, replace: true });

  const save = useServerFn(updateOrganization);
  const archive = useServerFn(archiveOwnOrganization);
  const listMembersFn = useServerFn(listMembers);

  // Shared with the cards: each read here feeds a summary line or a setup step,
  // and the same query key keeps the card's own copy in one cache entry.
  const ai = useQuery({ queryKey: ["ai_settings"], queryFn: () => getAiSettings({ data: undefined }) });
  const gate = useQuery({ queryKey: ["org_profile_gate"], queryFn: () => getOrgProfileGate() });
  const members = useQuery({ queryKey: ["org_members"], queryFn: () => listMembersFn({}) });
  const pay = useQuery({ queryKey: ["pay_settings"], queryFn: () => getPaySettings() });
  const labour = useQuery({ queryKey: ["labour_policy"], queryFn: () => getLabourPolicy() });
  const assessment = useQuery({ queryKey: ["assessment_policy"], queryFn: () => getAssessmentPolicy() });
  const phone = useQuery({ queryKey: ["phone_screening"], queryFn: () => getPhoneScreening() });
  const panel = useQuery({ queryKey: ["panel_agent"], queryFn: () => getPanelAgent() });
  const training = useQuery({ queryKey: ["training_status"], queryFn: () => getTrainingStatus() });

  const [form, setForm] = useState({
    name: "",
    legalName: "",
    industry: "",
    hqCity: "",
    hqCountry: "",
    employeeBand: "",
    currency: "INR",
    careersEmail: "",
    fiscalYearStartMonth: 4,
  });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const toggleRow = (id: string) => setOpenRows((o) => ({ ...o, [id]: !o[id] }));
  const openRow = (id: string, t: TabId) => {
    setTab(t);
    setOpenRows((o) => ({ ...o, [id]: true }));
  };

  useEffect(() => {
    if (!org) return;
    setForm({
      name: org.name,
      legalName: org.legal_name ?? "",
      industry: org.industry ?? "",
      hqCity: org.hq_city ?? "",
      hqCountry: org.hq_country ?? "",
      employeeBand: org.employee_band ?? "",
      currency: org.currency,
      careersEmail: org.careers_email ?? "",
      fiscalYearStartMonth: org.fiscal_year_start_month,
    });
  }, [org]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading organisation…</p>;

  const aiKeyConnected = Object.values(ai.data?.keys ?? {}).some(Boolean);
  const zones = pay.data?.conventions?.zones ?? [];
  const rates = pay.data?.rates ?? [];
  const sources = labour.data?.sources ?? [];
  const agentOn = labour.data?.agentOn ?? false;
  const rules = (labour.data?.findings ?? []).filter((f) => f.status === "approved").length;

  // The setup flow: real state, in the order a new tenant meets it.
  const steps = [
    {
      id: "ai",
      label: "Connect your AI key",
      done: aiKeyConnected,
      loading: ai.isLoading,
      go: () => navigate({ to: "/integrations", search: {} }),
    },
    {
      id: "profile",
      label: "Describe your organisation (profile approved)",
      done: gate.data?.approved === true,
      loading: gate.isLoading,
      go: () => navigate({ to: "/org-profile", search: {} }),
    },
    {
      id: "team",
      label: "Invite your team and assign approval roles",
      done: (members.data?.length ?? 0) > 1,
      loading: members.isLoading,
      go: () => navigate({ to: "/team", search: {} }),
    },
    {
      id: "zones",
      label: "Set your pay zones",
      done: zones.length > 0,
      loading: pay.isLoading,
      go: () => openRow("pay-settings", "pay"),
    },
    {
      id: "sources",
      label: "Add the official policy sources for your pay zones",
      done: sources.length > 0,
      loading: labour.isLoading,
      go: () => openRow("labour-policy", "rules"),
    },
  ];
  const stepsDone = steps.filter((s) => s.done).length;

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Organisation"
        description={
          isOwner
            ? "Owner settings for this tenant. Archiving keeps every requisition, candidate and interview record."
            : "Only an organisation owner can change these details."
        }
      />

      {/* Setup flow — real state, collapses to one line when everything is done */}
      <section className="panel mb-4 p-4" aria-label="Setup progress">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="size-4 text-muted-foreground" />
          Setup
          <span className="font-normal text-muted-foreground">
            {stepsDone} of {steps.length} done
          </span>
        </h2>
        {stepsDone === steps.length ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4" /> Your organisation is set up — hiring agents have
            everything they need.
          </p>
        ) : (
          <ol className="mt-2 space-y-1.5">
            {steps.map((s) => (
              <li key={s.id}>
                <button
                  onClick={s.go}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-accent/30",
                    s.done && "text-muted-foreground",
                  )}
                >
                  {s.loading ? (
                    <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
                  ) : s.done ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" />
                  ) : (
                    <CircleDashed className="size-4 shrink-0 text-primary" />
                  )}
                  <span className={cn(s.done && "line-through")}>{s.label}</span>
                  {!s.done && !s.loading && (
                    <span className="ml-auto text-xs font-medium text-primary">Do it →</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <nav className="mb-4 flex flex-wrap gap-1 border-b" aria-label="Organisation settings">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              tab === t.id
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="size-4" />
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "identity" && (
        <div className="space-y-3">
          <SettingsRow
            icon={<Building2 className="size-4" />}
            title="Profile"
            summary={`${form.name || "…"} · ${form.currency}${form.careersEmail ? "" : " · careers inbox not set"}`}
            open={openRows["profile"] ?? false}
            onToggle={() => toggleRow("profile")}
          >
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["name", "Organisation name"],
                    ["legalName", "Legal name"],
                    ["industry", "Industry"],
                    ["hqCity", "HQ city"],
                    ["hqCountry", "HQ country"],
                    ["employeeBand", "Employee band"],
                    ["currency", "Currency"],
                    ["careersEmail", "Careers email"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={key} className="text-xs">
                      {label}
                    </Label>
                    {key === "currency" ? (
                      <CodeSelect
                        id={key}
                        options={CURRENCY_OPTIONS}
                        disabled={!isOwner}
                        value={String(form[key])}
                        onChange={(code) => setForm({ ...form, currency: code })}
                        placeholder="Pick the currency"
                      />
                    ) : (
                      <Input
                        id={key}
                        disabled={!isOwner}
                        value={String(form[key])}
                        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      />
                    )}
                  </div>
                ))}
                <div className="space-y-1.5">
                  <Label htmlFor="fy" className="text-xs">
                    Fiscal year start month
                  </Label>
                  <Input
                    id="fy"
                    type="number"
                    min={1}
                    max={12}
                    disabled={!isOwner}
                    value={form.fiscalYearStartMonth}
                    onChange={(e) => setForm({ ...form, fiscalYearStartMonth: Number(e.target.value) })}
                  />
                </div>
              </div>
              {isOwner ? (
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await save({ data: form });
                      qc.invalidateQueries({ queryKey: ["my_org"] });
                      toast.success("Organisation updated");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Update failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Save changes
                </Button>
              ) : null}
            </div>
          </SettingsRow>

          <SettingsRow
            icon={<ScrollText className="size-4" />}
            title="How you hire — the organisation profile"
            summary={
              gate.data?.approved
                ? "Approved — agents write from it"
                : gate.data?.required
                  ? "Required, not approved yet"
                  : "Not written yet"
            }
            open={openRows["org-profile"] ?? false}
            onToggle={() => toggleRow("org-profile")}
          >
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                What your organisation does and how it hires — written with the Organisation context
                agent, approved by the HR head, and the context every hiring agent works from.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link to="/org-profile">Open the organisation profile</Link>
              </Button>
            </div>
          </SettingsRow>
        </div>
      )}

      {tab === "pay" && (
        <SettingsRow
          icon={<Coins className="size-4" />}
          title="Pay, currency and pay zones"
          summary={`Reporting ${pay.data?.conventions?.reportingCurrency ?? org?.currency ?? "…"} · ${zones.length} pay zones · ${rates.length} exchange rates`}
          open={openRows["pay-settings"] ?? false}
          onToggle={() => toggleRow("pay-settings")}
        >
          <PayConventionsCard />
        </SettingsRow>
      )}

      {tab === "rules" && (
        <div className="space-y-3">
          <SettingsRow
            icon={<Scale className="size-4" />}
            title="Labour & hiring policy"
            summary={`${agentOn ? "Agent on" : "Agent off"} · ${sources.length} sources · ${rules} rules in force`}
            open={openRows["labour-policy"] ?? false}
            onToggle={() => toggleRow("labour-policy")}
          >
            <LabourPolicyCard />
          </SettingsRow>
          <SettingsRow
            icon={<ListChecks className="size-4" />}
            title="Candidate assessment timeline"
            summary={
              assessment.data
                ? `Due in ${assessment.data.dueWorkingDays} working days · first reminder after ${assessment.data.firstReminderDays}`
                : "…"
            }
            open={openRows["assessment"] ?? false}
            onToggle={() => toggleRow("assessment")}
          >
            <AssessmentPolicyCard canEdit={navCtx.governance} />
          </SettingsRow>
        </div>
      )}

      {tab === "ai" && (
        <div className="space-y-3">
          <SettingsRow
            icon={<Phone className="size-4" />}
            title="AI phone screening"
            summary={
              phone.data
                ? phone.data.policy.enabled
                  ? `On · ${phone.data.policy.assistantName}`
                  : "Off"
                : "…"
            }
            open={openRows["phone"] ?? false}
            onToggle={() => toggleRow("phone")}
          >
            <PhoneScreeningCard canEdit={navCtx.governance} />
          </SettingsRow>
          <SettingsRow
            icon={<Bot className="size-4" />}
            title="Silent panel agent"
            summary={
              panel.data
                ? panel.data.policy.enabled
                  ? `On · rounds ${panel.data.policy.levels.join(", ")}`
                  : "Off"
                : "…"
            }
            open={openRows["panel"] ?? false}
            onToggle={() => toggleRow("panel")}
          >
            <SilentPanelCard canEdit={navCtx.governance} />
          </SettingsRow>
          <SettingsRow
            icon={<Archive className="size-4" />}
            title="Model training data"
            summary={
              training.data
                ? training.data.enabled
                  ? `On · kept ${training.data.retentionDays} days`
                  : "Off"
                : "…"
            }
            open={openRows["training"] ?? false}
            onToggle={() => toggleRow("training")}
          >
            <TrainingDataCard isOwner={Boolean(isOwner)} />
          </SettingsRow>
        </div>
      )}

      {tab === "lifecycle" && isOwner && (
        <section className="panel space-y-2 border-destructive/40 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <Archive className="size-4" /> Archive organisation
          </h2>
          <p className="text-sm text-muted-foreground">
            Everyone loses access to {org?.name} immediately. Nothing is deleted — a platform super
            user can restore it at any time.
          </p>
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            Archive organisation
          </Button>
        </section>
      )}
      {tab === "lifecycle" && !isOwner && (
        <p className="text-sm text-muted-foreground">
          Only an organisation owner can archive the organisation.
        </p>
      )}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {org?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All members, including you, lose access until a platform super user restores the
              organisation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (e) => {
                e.preventDefault();
                try {
                  await archive({ data: { reason } });
                  setConfirm(false);
                  await refetch();
                  toast.success("Organisation archived");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Archive failed");
                }
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
