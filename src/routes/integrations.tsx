import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Inbox,
  KeyRound,
  Loader2,
  Mail,
  Plug,
  RefreshCw,
  Sparkles,
  Video,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Tables } from "@/lib/database.types";
import {
  disconnectIntegration,
  listSourceIntegrations,
  saveIntegration,
  testIntegration,
} from "@/lib/integrations.functions";
import { ensureBoardIntegrations } from "@/lib/boards.functions";
import {
  getAiSettings,
  removeAiKey,
  saveAiSettings,
  testAiModel,
} from "@/lib/ai-settings.functions";
import { getEmailSettings, saveEmailSettings } from "@/lib/email-settings.functions";
import {
  disconnectLinkedIn,
  linkedinCapabilities,
  linkedinStatus,
  startLinkedInConnect,
} from "@/lib/linkedin.functions";
import {
  disconnectHrmsIntegration,
  listHrmsIntegrations,
  saveHrmsIntegration,
  syncHrmsNow,
  testHrmsIntegration,
} from "@/lib/hrms.functions";
import { hrmsProviderMeta } from "@/lib/hrms";
import {
  startGoogleMeetConnect,
  startMicrosoftConnect,
  startZoomConnect,
} from "@/lib/integrations-oauth.functions";
import { orgInbox } from "@/lib/local-inbox.functions";

import { collectApplicants, type CollectSummary } from "@/lib/collect.functions";
import { captureSetup, rotateCaptureToken } from "@/lib/capture.functions";
import { PageHeader } from "@/components/ats";
import { BoardConnectPanel } from "@/components/board-connect-panel";
import { BoardEnterprisePanel } from "@/components/board-enterprise-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Integration = Tables<"source_integrations">;

const integrationsQuery = queryOptions({
  queryKey: ["source_integrations"],
  queryFn: async () => (await listSourceIntegrations()) as Integration[],
});

type HrmsSyncInfo = {
  last_run_at: string | null;
  last_run_status: string;
  last_error: string | null;
  last_full_sync_at: string | null;
  cached_employees: number;
};

type HrmsConnection = {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  has_credentials: boolean;
  last_test_status: string;
  last_test_message: string | null;
  last_tested_at: string | null;
  base_url: string | null;
  credential_fields: string[];
  sync: HrmsSyncInfo;
};

const hrmsQuery = queryOptions({
  queryKey: ["hrms_integrations"],
  queryFn: async () => (await listHrmsIntegrations()) as HrmsConnection[],
});

const FIELD_LABEL: Record<string, string> = {
  client_id: "Client ID",
  client_secret: "Client secret",
  account_id: "Recruiter account ID",
  api_key: "API key",
  employer_id: "Employer ID",
  token: "Personal access token",
  refresh_token: "OAuth refresh token",
  tenant_id: "Azure tenant ID",
  organizer_email: "Organizer mailbox (host)",
};

/** Plain-English hint shown under each credential box. */
const FIELD_HINT: Record<string, string> = {
  client_id: "A long public code shown on the app page after you create the app. Safe to copy.",
  client_secret: "The private password for that app. Shown only once — copy it right away.",
  account_id: "Your company's account number, shown on the same app page.",
  api_key: "A single long key your account manager or the developer portal gives you.",
  employer_id: "Your employer/company number on the job board.",
  token: "A read-only token you generate in your own account settings.",
  refresh_token: "A long-lived code your own registered app's sign-in flow returns.",
  tenant_id: "Your organisation's directory ID in Microsoft Entra (Azure AD).",
  organizer_email: "The mailbox that will host the interviews, e.g. interviews@yourcompany.com.",
};

type SetupGuide = {
  who: string;
  minutes: string;
  links: { label: string; href: string }[];
  steps: string[];
};

/** Step-by-step, non-technical setup instructions per provider. */
const SETUP_GUIDE: Record<string, SetupGuide> = {
  linkedin: {
    who: "Nothing technical for HR. One person connects the company's LinkedIn account; everyone publishes job posts through it.",
    minutes: "Under a minute",
    links: [],
    steps: [
      "Press “Connect LinkedIn” above and sign in with your company's LinkedIn account — one time, for the whole team. The card title turns green when it is done.",
      "Open any approved requisition, press “Design post”, then “Publish to LinkedIn”. That is the whole job.",
      "Each post carries your ATSIQ apply link, so CVs sent from LinkedIn arrive in the talent pool and the role's pipeline on their own — read, scored and ready, with nothing to download.",
      "The requisition's “Job boards” panel also checks whether your contract opens LinkedIn's structured Jobs board and applicant sync — if LinkedIn declines, posts keep going out on the feed with your apply link.",
    ],
  },

  naukri: {
    who: "Needs a Naukri Resdex / RMS employer subscription. Ask your Naukri account manager for API access.",
    minutes: "10 min once Naukri sends your pack",
    links: [
      { label: "Naukri employer portal", href: "https://recruit.naukri.com/" },
      { label: "Naukri employer support", href: "https://www.naukri.com/recruiter-services" },
    ],
    steps: [
      "Email your Naukri account manager and ask for “Resdex API credentials for our ATS” — the ready-to-send request in the connect panel above covers every detail to ask for.",
      "They send an onboarding pack with a client ID, client secret, an account ID and an API base URL.",
      "Paste all four below (base URL goes in the last box) and press “Connect Naukri” — one press saves the keys and verifies them against Naukri's token endpoint. The card title turns green when it connects.",
      "Press “Set up” under Application webhook and give the generated callback URL to your account manager — applicants Naukri delivers arrive in the pipeline on their own.",
      "Job posting and applicant pulls stay unavailable until the pack lists those endpoints — the “What this connection can do” panel and the checklist show exactly what is missing.",
    ],
  },
  indeed: {
    who: "Needs an Indeed employer account with the Indeed Apply integration enabled.",
    minutes: "10 min once Indeed approves your account",
    links: [
      { label: "Indeed employer sign-in", href: "https://employers.indeed.com/" },
      { label: "Indeed partner / API portal", href: "https://developer.indeed.com/" },
    ],
    steps: [
      "Sign in to the Indeed employer account and request Indeed Apply / partner access for your ATS — the ready-to-send request in the connect panel above covers every detail to ask for.",
      "Paste the client ID and client secret below (plus your employer ID), then press “Connect Indeed” — one press saves the keys and verifies them against Indeed's token endpoint. The card title turns green when it connects.",
      "Press “Set up” under Application webhook and register the generated URL as the apply endpoint on your Indeed account — Indeed signs every delivery, ATSIQ verifies it before filing anyone.",
      "Applicants from your Indeed jobs then appear in the pipeline automatically, parsed and scored.",
    ],
  },
  github: {
    who: "Anyone with a free GitHub account. Optional — it only raises the hourly limit.",
    minutes: "2 min",
    links: [
      {
        label: "Create a read-only token",
        href: "https://github.com/settings/tokens/new?description=ATS%20candidate%20verification&scopes=public_repo",
      },
    ],
    steps: [
      "Open the link, sign in, set expiry to “No expiration” (or 1 year), leave all tick boxes unchecked.",
      "Press Generate token and copy the value that appears once.",
      "Paste it below and press Test connection. Without a token the app still works, just slower.",
    ],
  },
  careers: {
    who: "Nothing to configure — this is the built-in careers page source.",
    minutes: "0 min",
    links: [],
    steps: [
      "Leave this on. Applicants from your own careers page land straight in the talent pool.",
    ],
  },
  zoom: {
    who: "Your organisation's own Zoom account under the company's Zoom tenant (licensed plan recommended for longer interviews).",
    minutes: "2 min",
    links: [],
    steps: [
      "Press Connect Zoom above and sign in with that organisation account — not a personal one.",
      "Accept the meeting:write permission screen.",
      "Done: scheduled interviews get a Zoom join link automatically.",
    ],
  },
  google_meet: {
    who: "Your organisation's shared scheduling mailbox on Google Workspace (for example interviews@yourcompany.com), with Google Calendar enabled for it.",
    minutes: "2 min",
    links: [],
    steps: [
      "Press Connect Google Meet above and sign in as that shared account — not a personal Gmail.",
      "Accept the calendar permission screen — Meet links are then minted on every online interview.",
      "Done: invites with the Meet link reach the candidate and the interviewer from your organisation's address.",
    ],
  },
  teams: {
    who: "Your organisation's own Microsoft 365 account for interviews (for example interviews@yourcompany.com). It must be a normal Teams-licensed user — a bare Exchange shared mailbox cannot sign in.",
    minutes: "2 min",
    links: [],
    steps: [
      "Press Connect Microsoft Teams above and sign in with that interview account.",
      "Accept the permissions screen — the app may need a one-time approval from your Microsoft 365 admin.",
      "Done: every scheduled interview gets a real Teams join link, and the invite reaches the candidate's inbox from your organisation's address.",
    ],
  },
};

function SetupHelp({ provider, label }: { provider: string; label: string }) {
  const guide = SETUP_GUIDE[provider];
  if (!guide) return null;
  return (
    <details className="mt-3 rounded-lg border border-border bg-surface-2 p-3 open:pb-4">
      <summary className="cursor-pointer text-sm font-medium">
        How do I get these? — step-by-step for {label}
      </summary>
      <p className="mt-3 text-xs text-muted-foreground">
        {guide.who} · Roughly {guide.minutes}.
      </p>
      {guide.links.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {guide.links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-primary hover:bg-surface-1"
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      ) : null}
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">
        Stuck on a step? Forward this list to whoever administers the account — everything above
        happens on the provider’s own website, not here.
      </p>
    </details>
  );
}

export const Route = createFileRoute("/integrations")({
  head: () => ({
    meta: [
      { title: "Sourcing Integrations — LinkedIn, Naukri & Indeed APIs" },
      {
        name: "description",
        content:
          "Connect the company's LinkedIn account, Naukri Resdex, Indeed and GitHub, test each connection and enable them as sourcing channels.",
      },
      { property: "og:title", content: "Sourcing Integrations" },
      {
        property: "og:description",
        content:
          "HR-configurable job board and profile API credentials with live connection tests.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Integrations,
});

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { icon: typeof CheckCircle2; cls: string; label: string }> = {
    ok: { icon: CheckCircle2, cls: "text-emerald-600", label: "Connected" },
    pending: { icon: CircleDashed, cls: "text-amber-600", label: "Needs setup" },
    failed: { icon: CircleAlert, cls: "text-destructive", label: "Failed" },
    untested: { icon: CircleDashed, cls: "text-muted-foreground", label: "Not configured" },
  };
  const { icon: Icon, cls, label } = map[status] ?? map["untested"]!;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cls}`}>
      <Icon className="size-3.5" /> {label}
    </span>
  );
}

/**
 * LinkedIn's card pill cannot come from last_test_status — the OAuth callback
 * writes org_linkedin_connections and never touches the source_integrations
 * row. It mirrors the organisation's live connection instead (shared
 * ["linkedin_connect"] cache with LinkedinOneClick).
 */
function LinkedinStatusPill() {
  const status = useQuery({
    queryKey: ["linkedin_connect"],
    queryFn: () => linkedinStatus({ data: undefined }),
    refetchOnWindowFocus: true,
  });
  const s = status.data;
  if (!s || !s.configured) return <StatusPill status="untested" />;
  return <StatusPill status={s.connected ? "ok" : "pending"} />;
}

/** Shared credential inputs (used directly, or tucked away for LinkedIn). */
function CredentialFields({
  fields,
  hasCredentials,
  secrets,
  setSecrets,
  baseUrl,
  setBaseUrl,
  showBaseUrl,
}: {
  fields: string[];
  hasCredentials: boolean;
  secrets: Record<string, string>;
  setSecrets: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  showBaseUrl: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field}>
          <Label className="text-xs text-muted-foreground">{FIELD_LABEL[field] ?? field}</Label>
          <Input
            type={field === "organizer_email" ? "email" : "password"}
            autoComplete="off"
            placeholder={hasCredentials ? "•••••• stored — leave blank to keep" : "Paste value"}
            value={secrets[field] ?? ""}
            onChange={(e) => setSecrets((p) => ({ ...p, [field]: e.target.value }))}
          />
          {FIELD_HINT[field] ? (
            <p className="mt-1 text-xs text-muted-foreground">{FIELD_HINT[field]}</p>
          ) : null}
        </div>
      ))}
      {showBaseUrl ? (
        <div className="sm:col-span-2">
          <Label className="text-xs text-muted-foreground">Partner API base URL</Label>
          <Input
            placeholder="https://api.partner.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Supplied in your partner onboarding pack. Required before search and applicant pulls can
            run.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Your organisation's own LinkedIn account. An admin presses Connect once,
 * signs in on LinkedIn's own screen, and every job post from this workspace
 * goes out from that account. Nothing to paste, and no other company's account
 * is ever involved.
 */
/** Copy-ready note HR can send to their LinkedIn account manager. */
const LINKEDIN_REQUEST = `Subject: Request to enable Job Posting and Applicant data access on our LinkedIn contract

Hello,

We use an applicant tracking system (ATSIQ) alongside our LinkedIn Recruiter seats. Our LinkedIn account is already
authorised in the system and we can publish posts from it.

Two products are not on our contract, and LinkedIn currently returns "not found" for both:

1. Job Posting — to publish our roles as structured job listings on the LinkedIn Jobs board.
2. Applicant / candidate data access (Talent Solutions) — to receive applicants and their CVs directly into our ATS.

Please confirm what is required to add these to our contract: the products, the commercial terms, and any partner
programme application or security review we need to complete. We are ready to provide company details, use case and
technical contacts.

Thank you,
[Your name] — [Company] — [Contact number]`;

function LinkedinOneClick() {
  const qc = useQueryClient();
  const start = useServerFn(startLinkedInConnect);
  const drop = useServerFn(disconnectLinkedIn);
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const collect = useServerFn(collectApplicants);
  const [collecting, setCollecting] = useState(false);
  const [summary, setSummary] = useState<CollectSummary | null>(null);

  async function onCollect() {
    setCollecting(true);
    setSummary(null);
    try {
      const result = await collect({ data: {} });
      setSummary(result);
      toast.success(
        `${result.imported + result.updated} CV(s) filed · ${result.scored} scored and ready`,
      );
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["match_scores"] });
      qc.invalidateQueries({ queryKey: ["candidates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not collect applicants");
    } finally {
      setCollecting(false);
    }
  }

  const status = useQuery({
    queryKey: ["linkedin_connect"],
    queryFn: () => linkedinStatus({ data: undefined }),
    refetchOnWindowFocus: true,
    refetchInterval: awaiting ? 4000 : false,
  });
  const s = status.data;

  const caps = useQuery({
    queryKey: ["linkedin_caps"],
    queryFn: () => linkedinCapabilities({ data: undefined }),
    enabled: Boolean(s?.connected),
  });

  useEffect(() => {
    if (awaiting && s?.connected) {
      setAwaiting(false);
      toast.success("LinkedIn connected for your organisation");
    }
  }, [awaiting, s?.connected]);

  // The sign-in returns to /integrations?linkedin=connected|error
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("linkedin");
    if (!outcome) return;
    if (outcome === "connected") toast.success("LinkedIn connected for your organisation");
    else toast.error(params.get("detail") ?? "LinkedIn sign-in did not complete");
    window.history.replaceState({}, "", "/integrations");
    qc.invalidateQueries({ queryKey: ["linkedin_connect"] });
  }, [qc]);

  async function onConnect() {
    setBusy(true);
    // LinkedIn refuses to load inside an embedded frame, so the sign-in must
    // always happen in a real browser tab of its own. Do not pass `noopener`
    // here: browsers then intentionally return `null`, which leaves the newly
    // opened tab stranded on about:blank before the async URL is available.
    const tab = window.open("", "atsiq-linkedin-connect");
    if (tab) {
      tab.document.title = "Opening LinkedIn…";
      tab.document.body.textContent = "Opening LinkedIn sign-in…";
    }
    try {
      const { url } = await start({ data: { origin: window.location.origin } });
      if (tab) {
        tab.location.replace(url);
        setAwaiting(true);
      } else if (window.top) {
        window.top.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error ? e.message : "Could not start LinkedIn sign-in");
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await drop({ data: undefined });
      toast.success("LinkedIn disconnected");
      qc.invalidateQueries({ queryKey: ["linkedin_connect"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  const body = status.isLoading
    ? "Checking your LinkedIn connection…"
    : !s?.configured
      ? "LinkedIn sign-in is not switched on for this platform yet — ask your ATSIQ administrator."
      : s.connected
        ? `Connected as ${s.member ?? "your company's LinkedIn account"}${s.memberEmail ? ` (${s.memberEmail})` : ""}. Job posts from this workspace go out from this account.`
        : "Press Connect LinkedIn, sign in with your company's LinkedIn Recruiter account, and you're done — one time, for your whole team.";

  return (
    <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" />
          Your organisation's LinkedIn account
        </div>
        {s?.connected ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <CheckCircle2 className="size-3.5" /> Connected{s.member ? ` — ${s.member}` : ""}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CircleDashed className="size-3.5" /> Not connected
          </span>
        )}
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {awaiting ? (
        <p className="mt-2 inline-flex items-center gap-2 text-sm text-primary">
          <Loader2 className="size-4 animate-spin" /> Waiting for you to finish signing in on the
          LinkedIn tab that just opened — you can close it once LinkedIn says you're done.
        </p>
      ) : null}

      {s?.connected ? (
        <div className="mt-3 rounded-lg border border-border bg-background p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">What this account can do</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => caps.refetch()}
              disabled={caps.isFetching}
            >
              {caps.isFetching ? <Loader2 className="size-4 animate-spin" /> : null} Re-check
            </Button>
          </div>
          {caps.isLoading ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Asking LinkedIn what your seat allows…
            </p>
          ) : caps.error ? (
            <p className="mt-2 text-sm text-destructive">
              {caps.error instanceof Error ? caps.error.message : "Could not check this account."}
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {(caps.data ?? []).map((c) => (
                <li key={c.id} className="flex gap-2 text-sm">
                  {c.ready === true ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : c.ready === false ? (
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  ) : (
                    <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span>
                    <span className="font-medium">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {s?.connected && (caps.data ?? []).some((c) => c.ready === false) ? (
        <details className="mt-3 rounded-lg border border-border bg-background p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Ask LinkedIn to switch on the missing pieces — ready-to-send note
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            A Recruiter seat on its own does not include the job-posting or applicant products. Only
            LinkedIn can add them to your contract, so send this to your LinkedIn account manager.
            Everything else in ATSIQ keeps working while you wait.
          </p>
          <pre className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-xs">
            {LINKEDIN_REQUEST}
          </pre>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              navigator.clipboard.writeText(LINKEDIN_REQUEST);
              toast.success("Request copied — paste it into your email to LinkedIn");
            }}
          >
            Copy request
          </Button>
        </details>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onConnect} disabled={busy || !s?.configured}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {s?.connected ? "Reconnect LinkedIn" : "Connect LinkedIn"}
        </Button>
        {s?.connected ? (
          <Button size="sm" variant="outline" onClick={onCollect} disabled={collecting}>
            {collecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Inbox className="size-4" />
            )}
            {collecting ? "Collecting CVs and scoring…" : "Collect CVs from live posts"}
          </Button>
        ) : null}
        {s?.connected ? (
          <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : null}
      </div>

      {summary ? (
        <div className="mt-3 rounded-lg border border-border bg-background p-3 text-sm">
          <p className="font-medium">
            {summary.imported} new · {summary.updated} updated · {summary.scored} scored and ready
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Read {summary.scanned} incoming message(s); {summary.skipped} had no readable CV.
            {summary.importErrors || summary.scoreErrors
              ? ` ${summary.importErrors + summary.scoreErrors} needed attention.`
              : ""}
          </p>
          {summary.top.length ? (
            <ul className="mt-2 space-y-1 text-xs">
              {summary.top.map((t) => (
                <li key={`${t.candidate}-${t.requisition}`}>
                  <span className="font-medium">{t.candidate}</span> — {t.requisition} ·{" "}
                  <span className="text-primary">{t.score}/100</span>
                </li>
              ))}
            </ul>
          ) : null}
          {summary.mailboxNote ? (
            <p className="mt-2 text-xs text-amber-600">{summary.mailboxNote}</p>
          ) : null}
          {summary.linkedinNote ? (
            <p className="mt-1 text-xs text-muted-foreground">{summary.linkedinNote}</p>
          ) : null}
        </div>
      ) : null}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>
          Each organisation connects its own account. Your posts, and the applications they bring
          in, stay inside your workspace.
        </li>
        <li>
          CVs come back automatically: through the apply link inside each post, and through the
          careers mailbox import below, which reads LinkedIn application emails and files the
          attached CVs on its own.
        </li>
        <li>
          Reading other people's LinkedIn profiles directly needs a paid LinkedIn Talent Solutions
          data agreement — a Recruiter seat alone does not include it. Use the request below to
          start that with LinkedIn.
        </li>
      </ul>

      <details className="mt-3 rounded-lg border border-border bg-background p-3">
        <summary className="cursor-pointer text-xs font-medium">
          Ask LinkedIn to switch on data access for ATSIQ — ready-to-send request
        </summary>
        <pre className="mt-3 whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {LINKEDIN_ACCESS_REQUEST}
        </pre>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => {
            void navigator.clipboard.writeText(LINKEDIN_ACCESS_REQUEST);
            toast.success("Request copied — send it to your LinkedIn account manager");
          }}
        >
          Copy request
        </Button>
      </details>
    </div>
  );
}

const LINKEDIN_ACCESS_REQUEST = `Subject: Recruiter System Connect / Talent Solutions data access for our ATS

Hello,

We run a paid LinkedIn Recruiter contract for our organisation and we have now
moved our hiring onto ATSIQ, our applicant tracking system.

We would like to enable data access on our contract so that ATSIQ can:
  - read applications and attached CVs from job posts we publish,
  - sync candidate stage and status back into Recruiter (Recruiter System Connect),
  - keep InMail and pipeline activity visible alongside our own records.

Please confirm:
  1. what is included in our current contract and what needs to be added,
  2. the commercial terms, and the approval steps and expected timeline,
  3. anything LinkedIn still needs to enable for the ATSIQ app, which is
     already registered — no vendor-side sign-up should be outstanding.

Our recruiting team is ready to complete whatever LinkedIn needs from our end.

Thank you,
[Your name] — [Title], [Company]`;

/**
 * Careers mailbox auto-import. The mailbox is authorised once, centrally; from
 * then on every application email — LinkedIn, job boards, direct applicants —
 * has its CV read, parsed and filed against the matching open role by itself.
 */
/** One-click delegated connect for a meeting provider — no secrets to paste. */
function MeetingOAuthPanel({ row }: { row: Integration }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const startMs = useServerFn(startMicrosoftConnect);
  const startGm = useServerFn(startGoogleMeetConnect);
  const startZm = useServerFn(startZoomConnect);
  const drop = useServerFn(disconnectIntegration);

  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const connectedEmail =
    typeof cfg["connected_email"] === "string" ? (cfg["connected_email"] as string) : "";
  // Credentials are the source of truth: a row whose secrets are gone is
  // disconnected even if a stale connected_email is still in config.
  const connected = Boolean(connectedEmail) && row.has_credentials;

  const provider = row.provider as "teams" | "google_meet" | "zoom";
  const startFn = provider === "teams" ? startMs : provider === "google_meet" ? startGm : startZm;
  const label =
    provider === "teams" ? "Microsoft Teams" : provider === "google_meet" ? "Google Meet" : "Zoom";

  async function onConnect() {
    setBusy(true);
    const tab = window.open("", `atsiq-${provider}-connect`);
    try {
      const { url } = await startFn({ data: { origin: window.location.origin } });
      if (tab) tab.location.replace(url);
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error ? e.message : "Could not start the connect flow");
    } finally {
      // The provider tab carries the rest of the flow; this page must not sit
      // on a spinner forever if the user turns to that tab and finishes there.
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await drop({ data: { integrationId: row.id } });
      toast.success(`${label} disconnected`);
      qc.invalidateQueries({ queryKey: ["source_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border bg-surface-2/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Plug className="size-4 text-primary" />
          One-click connect — no secrets to paste
        </div>
        {connected ? <Badge variant="secondary">Connected as {connectedEmail}</Badge> : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Sign in with your organisation's own scheduling account — a shared mailbox such as
        interviews@yourcompany.com, not a personal address (personal Gmail/Outlook accounts are
        refused). An organisation owner or HR head connects it once; every recruiter's schedule
        reuses the same account for invites and links.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {connected ? (
          <>
            <Button size="sm" variant="outline" onClick={onDisconnect} disabled={busy}>
              Disconnect {connectedEmail}
            </Button>
            <Button size="sm" variant="ghost" onClick={onConnect} disabled={busy}>
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Video className="size-3.5" />
              )}
              Use a different account
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onConnect} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Video className="size-3.5" />}
            Connect {label}
          </Button>
        )}
      </div>
      {connected ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Switching accounts is safe: the current one keeps working until the new sign-in completes.
        </p>
      ) : null}
    </div>
  );
}

function CareersInboxPanel() {
  const mine = useQuery({
    queryKey: ["org_inbox"],
    queryFn: () => orgInbox({ data: undefined }),
    refetchOnWindowFocus: false,
  });
  const address = mine.data?.address ?? null;

  return (
    <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Inbox className="size-4 text-primary" />
          Your careers mailbox
        </div>
        {mine.isLoading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Checking
          </span>
        ) : address ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <CheckCircle2 className="size-3.5" /> Live
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CircleDashed className="size-3.5" /> Not ready
          </span>
        )}
      </div>

      {address ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Your organisation has its own address. Put it on your LinkedIn posts and job-board
            alerts, or forward application mail to it, and every attached CV is read, filed against
            the right role and scored on its own.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
              {address}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(address);
                toast.success("Address copied");
              }}
            >
              Copy address
            </Button>
          </div>
          <p className="num mt-3 text-xs text-muted-foreground">
            {mine.data?.counts.total ?? 0} mails received · {mine.data?.counts.imported ?? 0} new
            candidates · {mine.data?.counts.updated ?? 0} refreshed ·{" "}
            {mine.data?.counts.errors ?? 0} need a look
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Your careers address is created with your organisation. If it is missing, ask your ATSIQ
          administrator to finish onboarding for this workspace.
        </p>
      )}
    </div>
  );
}

/**
 * Browser companion. The recruiter stays signed in on the job board in their
 * own browser; one press sends the page they are reading — a CV or a job
 * description — into ATSIQ, where it is parsed, filed and scored.
 */
function CapturePanel() {
  const qc = useQueryClient();
  const setup = useQuery({
    queryKey: ["capture_setup"],
    queryFn: () => captureSetup({ data: undefined }),
    refetchOnWindowFocus: false,
  });
  const rotate = useServerFn(rotateCaptureToken);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = setup.data;

  async function onRotate() {
    setBusy(true);
    try {
      const next = await rotate({ data: undefined });
      qc.setQueryData(["capture_setup"], next);
      toast.success("New capture key issued — update it in the companion.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not issue a new key");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    fetch("/atsiq-capture.zip")
      .then((res) => {
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "atsiq-capture.zip";
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((err) => toast.error(err.message));
  }

  return (
    <div className="mt-4 rounded-lg border bg-surface-2/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Plug className="size-4 text-primary" />
          Grab a page from your own browser
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={download}>
            Download the companion
          </Button>
          <Button size="sm" variant="ghost" onClick={onRotate} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            New key
          </Button>
        </div>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        Stay signed in to LinkedIn Recruiter or any job board as you normally do. Looking at a
        single CV or job description, press the companion once and it comes across. On a Recruiter
        applicant list, press
        <span className="font-medium text-foreground"> Start sweep</span> instead: the job becomes a
        role here, then each applicant is opened in turn in your own browser, read, de-duplicated,
        matched and scored — up to 25 per run, at a deliberately slow human pace, with a live count
        and a Stop button. Your sign-in never leaves your machine and nothing runs unattended.
      </p>

      <div className="mt-3 grid gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Capture key</span>
          <code className="rounded bg-surface-2 px-2 py-1 font-mono">
            {data?.token ? (reveal ? data.token : "•".repeat(24)) : "—"}
          </code>
          <Button size="sm" variant="ghost" onClick={() => setReveal((v) => !v)}>
            {reveal ? "Hide" : "Show"}
          </Button>
          {data?.token ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(data.token ?? "");
                toast.success("Capture key copied");
              }}
            >
              Copy
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground">
          Paste it into the companion together with your ATSIQ address. Treat it like a password —
          anyone holding it can add candidates to your workspace.
        </p>
      </div>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>Download and unzip the companion (re-download it if you installed an older copy).</li>
        <li>Open chrome://extensions and turn on Developer mode.</li>
        <li>Choose “Load unpacked” and pick the unzipped folder.</li>
        <li>Open it once, paste your ATSIQ address and the key above, and save.</li>
        <li>
          In LinkedIn Recruiter open a job, choose the applicants view, then press Start sweep in
          the companion.
        </li>
      </ol>

      <p className="mt-3 text-xs text-muted-foreground">
        Captured CVs and roles appear in the Talent pool and Requisitions pages.
      </p>
    </div>
  );
}

function IntegrationCard({ row }: { row: Integration }) {
  const qc = useQueryClient();
  const save = useServerFn(saveIntegration);

  const test = useServerFn(testIntegration);
  const disconnect = useServerFn(disconnectIntegration);

  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const [enabled, setEnabled] = useState(row.enabled);
  // Keep the switch in sync with the saved value after any refetch.
  useEffect(() => setEnabled(row.enabled), [row.enabled]);
  const [baseUrl, setBaseUrl] = useState(
    typeof cfg["base_url"] === "string" ? (cfg["base_url"] as string) : "",
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "test" | "clear" | null>(null);
  // Collapsed by default so the page reads as a short, calm list.
  const [expanded, setExpanded] = useState(false);

  const provider = row.provider as
    "linkedin" | "naukri" | "indeed" | "github" | "careers" | "zoom" | "google_meet" | "teams";
  const isMeeting = row.category === "meeting";
  const notes = typeof cfg["notes"] === "string" ? (cfg["notes"] as string) : null;
  const docs = typeof cfg["docs"] === "string" ? (cfg["docs"] as string) : null;

  async function onSave() {
    setBusy("save");
    try {
      await save({
        data: {
          integrationId: row.id,
          provider,
          enabled,
          config: { ...cfg, base_url: baseUrl } as Record<string, string>,
          secrets,
        },
      });
      setSecrets({});
      toast.success(`${row.label} settings saved`);
      qc.invalidateQueries({ queryKey: ["source_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    try {
      // Typed-but-unsaved values are the #1 cause of a "not fully configured"
      // failure, so persist them first and then test what is actually stored.
      const pending = Object.values(secrets).some((v) => v.trim().length > 0);
      if (pending) {
        await save({
          data: {
            integrationId: row.id,
            provider,
            enabled,
            config: { ...cfg, base_url: baseUrl } as Record<string, string>,
            secrets,
          },
        });
        setSecrets({});
      }
      const outcome = await test({ data: { integrationId: row.id, provider } });
      if (outcome.status === "ok") toast.success(outcome.message);
      else if (outcome.status === "pending") toast.warning(outcome.message);
      else toast.error(outcome.message);
      qc.invalidateQueries({ queryKey: ["source_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    setBusy("clear");
    try {
      await disconnect({ data: { integrationId: row.id } });
      setEnabled(false);
      toast.success("Credentials removed");
      qc.invalidateQueries({ queryKey: ["source_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <ChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <Plug className="size-4 shrink-0 text-primary" />
          <span className="truncate font-medium">{row.label}</span>
          {provider === "linkedin" ? (
            <LinkedinStatusPill />
          ) : (
            <StatusPill status={row.last_test_status} />
          )}
        </button>
        <div className="flex items-center gap-2">
          {row.has_credentials ? (
            <span title="Credentials stored" className="text-muted-foreground">
              <KeyRound className="size-3.5" />
            </span>
          ) : null}
          <Label className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</Label>
          <Switch
            checked={enabled}
            disabled={busy === "save"}
            onCheckedChange={async (next) => {
              setEnabled(next);
              setBusy("save");
              try {
                await save({
                  data: {
                    integrationId: row.id,
                    provider,
                    enabled: next,
                    config: { ...cfg, base_url: baseUrl } as Record<string, string>,
                    secrets: {},
                  },
                });
                qc.invalidateQueries({ queryKey: ["source_integrations"] });
              } catch (e) {
                setEnabled(!next);
                toast.error(e instanceof Error ? e.message : "Could not update the switch");
              } finally {
                setBusy(null);
              }
            }}
          />
        </div>
      </div>

      {expanded ? (
        <div className="mt-4 border-t border-border pt-4">
          {notes ? <p className="text-sm text-muted-foreground">{notes}</p> : null}
          {row.last_test_message ? (
            <p className="mt-2 rounded-md bg-surface-2 p-3 text-xs text-muted-foreground">
              {row.last_test_message}
            </p>
          ) : null}
          {row.last_tested_at ? (
            <p className="num mt-2 text-xs text-muted-foreground">
              last tested {new Date(row.last_tested_at).toLocaleString()}
            </p>
          ) : null}

          {provider === "linkedin" ? <LinkedinOneClick /> : null}
          {provider === "naukri" || provider === "indeed" ? (
            <BoardConnectPanel
              provider={provider}
              label={row.label}
              integrationId={row.id}
              hasCredentials={row.has_credentials}
              lastTestStatus={row.last_test_status}
              lastTestMessage={row.last_test_message}
              config={cfg}
              baseUrl={baseUrl}
              secrets={secrets}
              onSecretsSaved={() => setSecrets({})}
            />
          ) : null}
          {provider === "linkedin" || provider === "careers" ? <CareersInboxPanel /> : null}
          {provider === "linkedin" || provider === "careers" ? <CapturePanel /> : null}
          {isMeeting ? <MeetingOAuthPanel row={row} /> : null}
          {provider === "linkedin" || provider === "indeed" || provider === "naukri" ? (
            <BoardEnterprisePanel
              provider={provider as "linkedin" | "indeed" | "naukri"}
              integrationId={row.id}
              enabled={enabled}
              hasCredentials={row.has_credentials}
              lastTestStatus={row.last_test_status}
              lastTestMessage={row.last_test_message}
            />
          ) : null}

          <SetupHelp provider={provider} label={row.label} />

          {isMeeting ? (
            row.credential_fields.length ? (
              // One-click OAuth is the normal path now that the platform's own
              // apps are registered; the manual boxes only serve self-hosted
              // installs (or a customer's own registered app), so they tuck
              // away instead of contradicting the "no secrets" headline.
              <details className="mt-4 rounded-lg border border-border bg-surface-2 p-3 open:pb-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced — connect with your own registered app instead
                </summary>
                <p className="mt-2 text-xs text-muted-foreground">
                  The one-click connect above uses ATSIQ&apos;s registered app and needs no secrets.
                  The boxes below are only for self-hosted installs that run without it, or for
                  connecting an app of your own.
                </p>
                <div className="mt-3">
                  <CredentialFields
                    fields={row.credential_fields}
                    hasCredentials={row.has_credentials}
                    secrets={secrets}
                    setSecrets={setSecrets}
                    baseUrl={baseUrl}
                    setBaseUrl={setBaseUrl}
                    showBaseUrl={false}
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={onSave} disabled={busy !== null}>
                    {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null} Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={onTest} disabled={busy !== null}>
                    {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : null} Test
                    connection
                  </Button>
                  {row.has_credentials ? (
                    <Button size="sm" variant="ghost" onClick={onClear} disabled={busy !== null}>
                      Remove credentials
                    </Button>
                  ) : null}
                </div>
              </details>
            ) : null
          ) : (
            <>
              {row.credential_fields.length && provider !== "linkedin" ? (
                <div className="mt-4">
                  <CredentialFields
                    fields={row.credential_fields}
                    hasCredentials={row.has_credentials}
                    secrets={secrets}
                    setSecrets={setSecrets}
                    baseUrl={baseUrl}
                    setBaseUrl={setBaseUrl}
                    showBaseUrl={provider !== "github" && provider !== "careers"}
                  />
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                {provider !== "linkedin" ? (
                  <>
                    <Button size="sm" onClick={onSave} disabled={busy !== null}>
                      {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null} Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={onTest} disabled={busy !== null}>
                      {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : null} Test
                      connection
                    </Button>
                    {row.has_credentials ? (
                      <Button size="sm" variant="ghost" onClick={onClear} disabled={busy !== null}>
                        Remove credentials
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {docs ? (
                  <a
                    href={docs}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ml-auto text-xs text-primary underline-offset-4 hover:underline"
                  >
                    Provider API docs
                  </a>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

const PROVIDER_MODELS: Record<string, { id: string; label: string }[]> = {
  openai: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
  anthropic: [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
    { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
  ],
  google: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash — newest, fast" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro — deeper reasoning" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite — cheapest" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
};

function HrmsConnectionCard({ row }: { row: HrmsConnection }) {
  const qc = useQueryClient();
  const save = useServerFn(saveHrmsIntegration);
  const test = useServerFn(testHrmsIntegration);
  const disconnect = useServerFn(disconnectHrmsIntegration);
  const sync = useServerFn(syncHrmsNow);

  const meta = hrmsProviderMeta(row.provider);
  const [enabled, setEnabled] = useState(row.enabled);
  useEffect(() => setEnabled(row.enabled), [row.enabled]);
  const [baseUrl, setBaseUrl] = useState(row.base_url ?? "");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "test" | "clear" | "sync" | null>(null);
  const [expanded, setExpanded] = useState(false);

  const canSync = row.enabled && row.has_credentials;

  function payload() {
    return {
      integrationId: row.id,
      provider: row.provider as "keka" | "greythr",
      enabled,
      config: { base_url: baseUrl } as Record<string, string>,
      secrets,
    };
  }

  async function persistCurrent() {
    const pending = Object.values(secrets).some((v) => v.trim().length > 0);
    if (!pending) return;
    await save({ data: payload() });
    setSecrets({});
  }

  async function onSave() {
    setBusy("save");
    try {
      await save({ data: payload() });
      setSecrets({});
      toast.success(`${row.label} settings saved`);
      qc.invalidateQueries({ queryKey: ["hrms_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    try {
      // Typed-but-unsaved values would test the stored (old) credentials.
      await persistCurrent();
      const outcome = await test({
        data: { integrationId: row.id, provider: row.provider as "keka" | "greythr" },
      });
      if (outcome.status === "ok") toast.success(outcome.message);
      else if (outcome.status === "pending") toast.warning(outcome.message);
      else toast.error(outcome.message);
      qc.invalidateQueries({ queryKey: ["hrms_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    setBusy("clear");
    try {
      await disconnect({ data: { integrationId: row.id } });
      setEnabled(false);
      toast.success(`${row.label} disconnected — synced employee data deleted`);
      qc.invalidateQueries({ queryKey: ["hrms_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function onSync() {
    setBusy("sync");
    try {
      const result = await sync({ data: { integrationId: row.id } });
      if (result.status === "ok")
        toast.success(`${row.label}: ${result.upserted} employees synced`);
      else toast.error(`${row.label} sync failed: ${result.error ?? "unknown error"}`);
      qc.invalidateQueries({ queryKey: ["hrms_integrations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  }

  const syncPill =
    row.sync.last_run_status === "ok"
      ? "ok"
      : row.sync.last_run_status === "failed"
        ? "failed"
        : "untested";

  return (
    <article className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <ChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <Plug className="size-4 shrink-0 text-primary" />
          <span className="truncate font-medium">{row.label}</span>
          <StatusPill status={row.last_test_status} />
        </button>
        <div className="flex items-center gap-2">
          {row.has_credentials ? (
            <span title="Credentials stored" className="text-muted-foreground">
              <KeyRound className="size-3.5" />
            </span>
          ) : null}
          <Button size="sm" variant="outline" disabled={!canSync || busy !== null} onClick={onSync}>
            {busy === "sync" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Sync now
          </Button>
          <Label className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</Label>
          <Switch
            checked={enabled}
            disabled={busy === "save"}
            onCheckedChange={async (next) => {
              setEnabled(next);
              setBusy("save");
              try {
                await save({
                  data: {
                    integrationId: row.id,
                    provider: row.provider as "keka" | "greythr",
                    enabled: next,
                    config: { base_url: baseUrl } as Record<string, string>,
                    secrets: {},
                  },
                });
                toast.success(next ? `${row.label} enabled` : `${row.label} disabled`);
                qc.invalidateQueries({ queryKey: ["hrms_integrations"] });
              } catch (e) {
                setEnabled(!next);
                toast.error(e instanceof Error ? e.message : "Save failed");
              } finally {
                setBusy(null);
              }
            }}
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <StatusPill status={syncPill} />
          {row.sync.cached_employees > 0
            ? `${row.sync.cached_employees} employees cached`
            : "Not synced yet"}
          {row.sync.last_run_at
            ? ` · last run ${new Date(row.sync.last_run_at).toLocaleString()}`
            : ""}
        </span>
        {row.sync.last_error ? (
          <span className="truncate text-destructive" title={row.sync.last_error}>
            {row.sync.last_error}
          </span>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-4 space-y-3 border-t pt-4">
          {meta ? <p className="text-sm text-muted-foreground">{meta.blurb}</p> : null}
          {meta?.needsBaseUrl ? (
            <div className="space-y-1.5">
              <Label htmlFor={`hrms-base-${row.id}`}>API base URL</Label>
              <Input
                id={`hrms-base-${row.id}`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-tenant.greythr.com"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Your greytHR tenant API URL — the same address you use to sign in, ending in
                greythr.com.
              </p>
            </div>
          ) : null}
          {(row.credential_fields ?? []).map((field) => (
            <div key={field} className="space-y-1.5">
              <Label htmlFor={`hrms-${field}-${row.id}`}>{FIELD_LABEL[field] ?? field}</Label>
              <Input
                id={`hrms-${field}-${row.id}`}
                type="password"
                value={secrets[field] ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, [field]: e.target.value }))}
                placeholder={row.has_credentials ? "•••••••• (stored)" : ""}
                autoComplete="off"
              />
              {FIELD_HINT[field] ? (
                <p className="text-xs text-muted-foreground">{FIELD_HINT[field]}</p>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" onClick={onSave} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onTest} disabled={busy !== null}>
              {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Test connection
            </Button>
            {row.has_credentials ? (
              <Button size="sm" variant="ghost" onClick={onClear} disabled={busy !== null}>
                {busy === "clear" ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function AiModelCard() {
  const settings = useQuery({
    queryKey: ["ai_settings"],
    queryFn: () => getAiSettings({ data: undefined }),
  });
  const qc = useQueryClient();
  const save = useServerFn(saveAiSettings);
  const test = useServerFn(testAiModel);
  const removeKey = useServerFn(removeAiKey);

  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "clear" | null>(null);

  const s = settings.data;
  const activeProvider = provider ?? s?.provider ?? "openai";
  const models = PROVIDER_MODELS[activeProvider] ?? [];
  const activeModel =
    model ?? (provider && provider !== s?.provider ? models[0]?.id : s?.model) ?? "";
  const keyStored = s?.keys?.[activeProvider as "openai" | "anthropic" | "google"];

  async function onSave() {
    setBusy("save");
    try {
      await save({
        data: {
          provider: activeProvider as "openai" | "anthropic" | "google",
          model: activeModel,
          apiKey,
        },
      });
      setApiKey("");
      toast.success("Scoring model updated");
      qc.invalidateQueries({ queryKey: ["ai_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    try {
      const out = await test({
        data: {
          provider: activeProvider as "openai" | "anthropic" | "google",
          model: activeModel,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      });
      if (out.status === "ok") {
        // Testing uses the on-screen key directly; it is not stored until saved.
        toast.success(
          apiKey.trim() ? `${out.message} Now press Save to store this key.` : out.message,
        );
      } else toast.error(out.message);
      qc.invalidateQueries({ queryKey: ["ai_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  async function onClearKey() {
    setBusy("clear");
    try {
      await removeKey({ data: { provider: activeProvider as "openai" | "anthropic" | "google" } });
      toast.success("API key removed");
      qc.invalidateQueries({ queryKey: ["ai_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="panel p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles className="size-4 text-primary" />
        <h3 className="font-semibold">AI model for matching & scoring</h3>
        {s ? <StatusPill status={s.last_test_status} /> : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Drives every AI step: JD drafting, resume parsing, JD↔CV skill mapping, LinkedIn narrative
        scoring and AI screening. Deterministic scoring (experience band, GitHub signals, weighted
        roll-up) never uses a model.
      </p>
      <p className="mt-2 text-xs font-medium text-foreground">
        Your own key is required. Every AI action on this workspace is billed to the key saved here
        — there is no shared or platform key, and no other organisation&apos;s key is ever used.
        Until a key is saved, AI steps stop with a clear message instead of running on someone
        else&apos;s account.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={activeProvider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel(PROVIDER_MODELS[e.target.value]?.[0]?.id ?? "");
            }}
          >
            <option value="openai">OpenAI — your own API key</option>
            <option value="anthropic">Anthropic Claude — your own API key</option>
            <option value="google">Google Gemini — your own API key</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label>Model</Label>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={models.some((m) => m.id === activeModel) ? activeModel : "__custom"}
            onChange={(e) => setModel(e.target.value === "__custom" ? "" : e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom">Other (type an exact model id)</option>
          </select>
        </div>

        {!models.some((m) => m.id === activeModel) && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Model id</Label>
            <Input
              value={activeModel}
              onChange={(e) => setModel(e.target.value)}
              placeholder="exact model id"
            />
          </div>
        )}

        {
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="flex items-center gap-1.5">
              <KeyRound className="size-3.5" />
              {activeProvider === "openai"
                ? "OpenAI API key"
                : activeProvider === "anthropic"
                  ? "Anthropic API key"
                  : "Google Gemini API key"}
            </Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyStored ? "•••••••• stored — leave blank to keep" : "sk-…"}
            />
            <p className="text-xs text-muted-foreground">
              Stored server-side only; it is never returned to the browser.
            </p>
          </div>
        }
      </div>

      {s?.last_test_message ? (
        <p className="mt-3 text-xs text-muted-foreground">{s.last_test_message}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={busy !== null || !activeModel}>
          {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
        </Button>
        <Button size="sm" variant="outline" onClick={onTest} disabled={busy !== null}>
          {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : null} Test model
        </Button>
        {keyStored ? (
          <Button size="sm" variant="ghost" onClick={onClearKey} disabled={busy !== null}>
            Remove key
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function Integrations() {
  const qc = useQueryClient();
  const rows = useQuery(integrationsQuery);
  const hrmsRows = useQuery(hrmsQuery);
  const [seeding, setSeeding] = useState(false);
  // A rejected connect (wrong-domain mailbox, admin-consent refusal, …) bounces
  // back here as a query param; toasts vanish, so the reason is kept on-screen
  // in the meetings tab until dismissed.
  const [meetingNotice, setMeetingNotice] = useState<{
    name: string;
    detail: string | null;
  } | null>(null);

  // Meeting-provider connects return with ?meetings=connected|error&provider=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("meetings");
    if (!outcome) return;
    const provider = params.get("provider");
    const name =
      provider === "microsoft"
        ? "Microsoft Teams"
        : provider === "google"
          ? "Google Meet"
          : provider === "zoom"
            ? "Zoom"
            : "The provider";
    if (outcome === "connected") {
      toast.success(`${name} connected for your organisation`);
      setMeetingNotice(null);
    } else {
      setMeetingNotice({ name, detail: params.get("detail") });
    }
    window.history.replaceState({}, "", window.location.pathname);
    qc.invalidateQueries({ queryKey: ["source_integrations"] });
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Integrations"
        description="Connect the places your CVs and interviews come from, and your HRMS. Open a row only when you need to change it — everything you type is stored securely on the server."
      />

      <Tabs defaultValue="sourcing">
        <TabsList>
          <TabsTrigger value="sourcing">Candidate sources</TabsTrigger>
          <TabsTrigger value="meetings">Interview meetings</TabsTrigger>
          <TabsTrigger value="hrms">HRMS sync</TabsTrigger>
          <TabsTrigger value="emails">Candidate emails</TabsTrigger>
          <TabsTrigger value="ai">AI model</TabsTrigger>
        </TabsList>

        <TabsContent value="sourcing" className="space-y-3">
          {rows.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {(rows.data ?? [])
                .filter((r) => r.category !== "meeting" && r.category !== "hrms")
                .map((row) => (
                  <IntegrationCard key={row.id} row={row} />
                ))}
              {rows.data &&
              !["linkedin", "indeed", "naukri"].every((p) =>
                rows.data!.some((r) => r.provider === p),
              ) ? (
                <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
                  <p className="text-sm text-muted-foreground">
                    Some job-board connections are missing from this organisation's list (older
                    accounts created before the job-board catalog existed).
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={seeding}
                    onClick={async () => {
                      setSeeding(true);
                      try {
                        await ensureBoardIntegrations();
                        qc.invalidateQueries({ queryKey: ["source_integrations"] });
                        toast.success("Board connections added");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Could not add the rows");
                      } finally {
                        setSeeding(false);
                      }
                    }}
                  >
                    {seeding ? <Loader2 className="size-4 animate-spin" /> : null} Add missing board
                    connections
                  </Button>
                </div>
              ) : null}
            </>
          )}
          <details className="panel p-4 text-sm text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              What each source can do
            </summary>
            <ul className="mt-3 space-y-1.5">
              <li>
                <strong className="text-foreground">LinkedIn</strong> — sign in once as a company;
                job posts publish from a requisition and applicants arrive through your apply link.
              </li>
              <li>
                <strong className="text-foreground">ATSIQ Capture (Chrome extension)</strong> —
                while you browse LinkedIn Recruiter, capture the CV or job description you are
                looking at or run a guided sweep of an applicant list; everything lands in your
                talent pool, deduplicated and ready to score. Pair it with this organisation using
                the capture token shown above.
              </li>
              <li>
                <strong className="text-foreground">Public apply link</strong> — every requisition
                gets a shareable link; candidates apply without an account and land straight in the
                pipeline with their CV parsed.
              </li>
              <li>
                <strong className="text-foreground">Careers inbox</strong> — CVs emailed to your
                careers address are filed, read and scored automatically.
              </li>
              <li>
                <strong className="text-foreground">Naukri / Indeed</strong> — need an employer
                subscription; paste the keys your account manager sends.
              </li>
              <li>
                <strong className="text-foreground">GitHub</strong> — not an applicant source; it
                verifies the public engineering signals behind a candidate's claims. Works without
                setup; a token only makes it faster.
              </li>
              <li>
                <strong className="text-foreground">Bulk upload &amp; referrals</strong> — drop
                PDF/DOCX CVs into the talent pool or add candidates by hand; every source feeds the
                same deduplicated, scored pipeline.
              </li>
            </ul>
          </details>
        </TabsContent>

        <TabsContent value="meetings" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect one conferencing account and every interview gets a real join link and calendar
            invite.
          </p>
          {meetingNotice ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm font-medium">{meetingNotice.name} connect did not complete</p>
              {meetingNotice.detail ? (
                <p className="mt-1 text-sm text-muted-foreground">{meetingNotice.detail}</p>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="mt-1"
                onClick={() => setMeetingNotice(null)}
              >
                Dismiss
              </Button>
            </div>
          ) : null}
          {rows.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            (rows.data ?? [])
              .filter((r) => r.category === "meeting")
              .map((row) => <IntegrationCard key={row.id} row={row} />)
          )}
        </TabsContent>

        <TabsContent value="hrms" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Sync your employee master from your HRMS — departments, titles and leavers stay current,
            so hiring managers, interviewers and internal candidates come straight from your HR
            system instead of being re-keyed here. Your HRMS stays the system of record; ATSIQ keeps
            a read-only copy.
          </p>
          {hrmsRows.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            (hrmsRows.data ?? []).map((row) => <HrmsConnectionCard key={row.id} row={row} />)
          )}
          <details className="panel p-4 text-sm text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              How HRMS sync works
            </summary>
            <ul className="mt-3 space-y-1.5">
              <li>
                <strong className="text-foreground">
                  Paste credentials, press Test, then Sync
                </strong>{" "}
                — the first sync pulls your whole employee directory; afterwards it stays fresh
                automatically (and you can re-sync any time).
              </li>
              <li>
                <strong className="text-foreground">The HRMS is the source of truth</strong> —
                employees who leave are marked as leavers, never deleted, and nothing is ever
                written back to your HRMS.
              </li>
              <li>
                <strong className="text-foreground">Keka</strong> — paste the client ID, client
                secret and API key from your Keka developer/API settings.
              </li>
              <li>
                <strong className="text-foreground">greytHR</strong> — create an API user in greytHR
                (My Account → API Users), paste the key and your tenant API base URL.
              </li>
              <li>
                <strong className="text-foreground">More HRMS platforms</strong> — Workday,
                Darwinbox, ZingHR and Adrenalin are on the roadmap; disconnecting a platform also
                deletes its synced employee data.
              </li>
            </ul>
          </details>
        </TabsContent>

        <TabsContent value="emails">
          <EmailNotificationsCard />
        </TabsContent>

        <TabsContent value="ai">
          <AiModelCard />
        </TabsContent>
      </Tabs>
    </>
  );
}

type EmailSettingsForm = {
  enabled: boolean;
  ackEnabled: boolean;
  stageEnabled: boolean;
  interviewEnabled: boolean;
  offerEnabled: boolean;
  replyTo: string;
  timezone: string;
};

function EmailNotificationsCard() {
  const settings = useQuery({
    queryKey: ["email_settings"],
    queryFn: () => getEmailSettings({ data: undefined }),
  });
  const qc = useQueryClient();
  const save = useServerFn(saveEmailSettings);

  const [form, setForm] = useState<EmailSettingsForm | null>(null);
  const [busy, setBusy] = useState(false);

  const s = settings.data;
  const v: EmailSettingsForm | null =
    form ??
    (s
      ? {
          enabled: s.enabled,
          ackEnabled: s.ackEnabled,
          stageEnabled: s.stageEnabled,
          interviewEnabled: s.interviewEnabled,
          offerEnabled: s.offerEnabled,
          replyTo: s.replyTo ?? "",
          timezone: s.timezone,
        }
      : null);

  async function onSave() {
    if (!v) return;
    setBusy(true);
    try {
      await save({
        data: {
          enabled: v.enabled,
          ackEnabled: v.ackEnabled,
          stageEnabled: v.stageEnabled,
          interviewEnabled: v.interviewEnabled,
          offerEnabled: v.offerEnabled,
          replyTo: v.replyTo.trim() || null,
          timezone: v.timezone,
        },
      });
      toast.success("Candidate email preferences saved");
      setForm(null);
      qc.invalidateQueries({ queryKey: ["email_settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const toggles: {
    key: "ackEnabled" | "stageEnabled" | "interviewEnabled" | "offerEnabled";
    label: string;
    hint: string;
  }[] = [
    {
      key: "ackEnabled",
      label: "Application acknowledgment",
      hint: "Sent the moment a candidate applies through your apply page.",
    },
    {
      key: "stageEnabled",
      label: "Stage updates",
      hint: "Shortlist and interview-round progress notes as candidates advance.",
    },
    {
      key: "interviewEnabled",
      label: "Interview invitations",
      hint: "Invite with a calendar attachment whenever a round is scheduled or moved.",
    },
    {
      key: "offerEnabled",
      label: "Offer letters",
      hint: "The released offer letter, as a PDF attachment.",
    },
  ];

  return (
    <article className="panel p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Mail className="size-4 text-primary" />
        <h3 className="font-semibold">Candidate emails</h3>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Automatic emails to candidates at each step of their application. Every email is queued,
        retried and deduplicated on our side; replies go to your careers inbox unless you set a
        different address below.
      </p>

      {!v ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Candidate emails enabled</p>
              <p className="text-xs text-muted-foreground">
                Master switch — turns everything below off without losing your preferences.
              </p>
            </div>
            <Switch
              checked={v.enabled}
              onCheckedChange={(checked) => setForm({ ...v, enabled: checked })}
            />
          </div>

          <div className="grid gap-2">
            {toggles.map((t) => (
              <div
                key={t.key}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground">{t.hint}</p>
                </div>
                <Switch
                  checked={v[t.key]}
                  disabled={!v.enabled}
                  onCheckedChange={(checked) => setForm({ ...v, [t.key]: checked })}
                />
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="email-reply-to">Replies go to</Label>
              <Input
                id="email-reply-to"
                type="email"
                placeholder="careers@yourcompany.com"
                value={v.replyTo}
                onChange={(e) => setForm({ ...v, replyTo: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Defaults to your careers inbox address when left blank.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-timezone">Timezone for dates</Label>
              <Input
                id="email-timezone"
                placeholder="Asia/Kolkata"
                value={v.timezone}
                onChange={(e) => setForm({ ...v, timezone: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                IANA timezone used to format interview times in emails.
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={onSave} disabled={busy}>
              {busy ? "Saving…" : "Save email preferences"}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
