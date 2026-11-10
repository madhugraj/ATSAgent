import { useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  fetchMe,
  loginRequest,
  registerRequest,
  requestResetRequest,
  signOutApp,
} from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { workEmailProblem } from "@/lib/work-email";
import { PASSWORD_POLICY_HINT, passwordProblem } from "@/lib/password-policy";
import { PasswordInput } from "@/components/PasswordInput";
import { isPublicPath } from "@/lib/public-paths";
import { BrandFooter, BrandLogo } from "@/components/Brand";
import {
  BarChart3,
  BrainCircuit,
  Briefcase,
  Building2,
  CalendarCheck,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileSignature,
  GitCompareArrows,
  Globe2,
  Handshake,
  Layers,
  Lock,
  MessageSquare,
  PhoneCall,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from "lucide-react";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const location = useLocation();
  const [me, setMe] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const publicPath = isPublicPath(location.pathname);

  useEffect(() => {
    // Identity now lives in the atsiq_session httpOnly cookie; the server
    // tells us who is signed in. Anything cached before a sign-in transition
    // must be refetched under the new identity.
    let cancelled = false;
    fetchMe().then((email) => {
      if (cancelled) return;
      setMe(email);
      setReady(true);
      if (email) void qc.invalidateQueries();
    });
    // Never leave the app stuck on the splash if session restore stalls.
    const bail = setTimeout(() => setReady(true), 4000);
    return () => {
      cancelled = true;
      clearTimeout(bail);
    };
  }, [qc]);

  if (!ready && !publicPath) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }

  if (!me) return publicPath ? <>{children}</> : <Landing />;
  return <>{children}</>;
}

/* ------------------------------------------------------------------ content */

const HERO_PROOF = [
  "Stop losing strong candidates inside stale spreadsheets and disconnected tools",
  "Replace opaque AI rankings with evidence recruiters and hiring managers can inspect",
  "Give CHROs live quality, productivity, budget and pipeline governance",
  "Keep every organisation, role, decision and candidate hand-over accountable",
] as const;

const CAPABILITIES = [
  {
    icon: Briefcase,
    title: "Requisitions & JD authoring",
    body: "Raise demand against budgeted headcount, route it for approval, and generate a structured JD with must-have and good-to-have skills. Near-duplicate requisitions are flagged before they are raised.",
  },
  {
    icon: Users,
    title: "Talent pool that stays clean",
    body: "Bulk CV upload with automatic PDF/DOCX parsing, alias-aware duplicate detection, one-click merge, and freshness tiers so a two-year-old CV never masquerades as a live candidate.",
  },
  {
    icon: GitCompareArrows,
    title: "Defensible JD ↔ CV matching",
    body: "Skills 40, experience 15, career history 10, impact 10, education 10, social 15 — every score carries the evidence and rationale behind it, so a shortlist can be explained to the business.",
  },
  {
    icon: Globe2,
    title: "Live social & public signals",
    body: "LinkedIn, GitHub, portfolios and public writing are verified against what the CV claims, with the fetch audited. Recruiters can add links manually for AI review.",
  },
  {
    icon: CalendarCheck,
    title: "Interviews end to end",
    body: "Panel scheduling with calendar invites, Zoom / Meet / Teams links, competency scorecards that lock on submission, audited rescheduling, and automatic stage progression.",
  },
  {
    icon: FileSignature,
    title: "Offers to joining",
    body: "Offer creation, approval, acceptance and joining tracked as enforced lifecycle states with mandatory reasons on every rejection or hold.",
  },
  {
    icon: BarChart3,
    title: "Analytics for leadership",
    body: "Funnel conversion, drop-off, time to hire, offer accept rate, source mix, skill scarcity, interviewer load and department demand — filterable and exportable.",
  },
  {
    icon: MessageSquare,
    title: "Aditi, the embedded HR copilot",
    body: "An AI assistant grounded in your own live data and the product manual, so the team can configure and operate the system without a services engagement.",
  },
  {
    icon: CircleDollarSign,
    title: "Live market compensation",
    body: "Benchmark a role against current public salary evidence, see the source and confidence behind the range, and set a defensible hiring budget before approval.",
  },
  {
    icon: PhoneCall,
    title: "Screening-call intelligence",
    body: "Generate JD-and-CV-specific questions with the reason for asking and the expected answer, then score typed notes or a private call recording with evidence.",
  },
  {
    icon: Handshake,
    title: "Recruiter ownership & collaboration",
    body: "Give every candidate an accountable owner, preserve hand-over history, refer talent to colleagues, request candidates by role and mention teammates in notes.",
  },
  {
    icon: ShieldCheck,
    title: "CHRO performance governance",
    body: "Compare recruiter activity, quality, conversion, speed and target attainment, with transparent incentive bands and role-specific executive views.",
  },
] as const;

const PAIN_OUTCOMES = [
  {
    pain: "Strong profiles disappear in a growing database",
    outcome: "A clean, searchable talent pool",
    detail:
      "Duplicate detection, CV freshness, source and capture time, recruiter ownership, historic matching and automatic suggestions keep existing talent useful.",
  },
  {
    pain: "Shortlists are difficult to explain or challenge",
    outcome: "Evidence behind every score",
    detail:
      "JD ↔ CV fit, career history, impact, education and verified public signals are separated, weighted and shown with missing evidence and risk flags.",
  },
  {
    pain: "Screening quality depends on who makes the call",
    outcome: "Consistent preliminary assessment",
    detail:
      "Role-specific questions tell HR why to ask, what a strong answer should contain and how the candidate's actual response changed the fit assessment.",
  },
  {
    pain: "Leadership sees activity, but not hiring quality",
    outcome: "Governance with prescriptions",
    detail:
      "CHRO and HR-head views expose stalled demand, weak coverage, screening gaps, funnel leakage, offer health, budget risk and recruiter performance.",
  },
] as const;

const MODULES = [
  {
    step: "01",
    icon: Building2,
    title: "Onboard the organisation",
    body: "Register your company, get platform approval, then configure departments, hiring locations, currencies and master data before inviting internal users.",
  },
  {
    step: "02",
    icon: Layers,
    title: "Open the demand",
    body: "Raise a requisition, send it for CHRO or department-head approval, publish internally as an IJP or externally, and keep the approval trail attached.",
  },
  {
    step: "03",
    icon: Target,
    title: "Source and rank",
    body: "The pool is matched against the JD the moment it opens. Add the top-ranked candidates to the pipeline, or score a selection in bulk.",
  },
  {
    step: "04",
    icon: CalendarCheck,
    title: "Interview and decide",
    body: "Schedule panels, collect structured scorecards, and let select / hold / reject move the candidate through the lifecycle automatically.",
  },
  {
    step: "05",
    icon: FileSignature,
    title: "Offer and close",
    body: "Track offer, acceptance, joining or drop-off, with reasons captured for every outcome and reflected in leadership reporting.",
  },
] as const;

const WEIGHTS = [
  {
    label: "Skills match",
    value: 40,
    note: "Must-have and good-to-have coverage, weighted by recency",
  },
  { label: "Experience", value: 15, note: "Relevant years against the requisition band" },
  { label: "Career history", value: 10, note: "Tenure, stints, gaps and progression" },
  { label: "Impact & innovation", value: 10, note: "Ownership and outcomes evidenced in the CV" },
  { label: "Education", value: 10, note: "Qualification fit and institution signals" },
  {
    label: "Social & public proof",
    value: 15,
    note: "LinkedIn, GitHub, portfolio and public writing",
  },
] as const;

const GOVERNANCE = [
  {
    icon: ShieldCheck,
    title: "Tenant isolation",
    body: "Row-level security scopes every record to your organisation.",
  },
  {
    icon: Lock,
    title: "Role-based access",
    body: "Owner, CHRO, HR head, recruiter and interviewer scopes.",
  },
  {
    icon: ScrollText,
    title: "Full audit trail",
    body: "Approvals, stage moves, reschedules and score runs are logged.",
  },
  {
    icon: Database,
    title: "Your data, your keys",
    body: "Every intelligence feature runs on your organisation's own API key — your data and your AI spend stay yours.",
  },
] as const;

const STATS = [
  { value: "6", label: "Weighted scoring dimensions" },
  { value: "100%", label: "Scores with an evidence trail" },
  { value: "1", label: "System of record, requisition to joining" },
] as const;

const FAQ = [
  {
    q: "How do accounts work?",
    a: "There are no standalone users. A company registers, a platform super admin approves it, and only then can the organisation invite internal users on the same verified work-email domain.",
  },
  {
    q: "How does the AI work?",
    a: "Matching, scoring and drafting run on frontier large language models using your organisation's own API key. Your admin picks and tests the configuration per organisation on the integrations page.",
  },
  {
    q: "Do we have to type candidate details?",
    a: "No. Upload CVs in bulk; PDF and DOCX files are parsed into structured profiles, deduplicated against the existing pool, and matched automatically.",
  },
  {
    q: "Can a score be challenged?",
    a: "Yes. Every dimension exposes the evidence it used and the rationale behind the number, so a hiring manager can audit a shortlist line by line.",
  },
] as const;

/* ------------------------------------------------------------------- layout */

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <Hero />
      <PlatformFilm />
      <TrustStrip />
      <PainOutcomes />
      <Capabilities />
      <HowItWorks />
      <ScoringModel />
      <Governance />
      <Faq />
      <ClosingCta />
      <BrandFooter />
    </div>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-5 py-3">
        <div className="flex items-center gap-3">
          <BrandLogo className="h-6" />
          <span className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            ATSIQ
          </span>
        </div>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#capabilities" className="hover:text-foreground">
            Capabilities
          </a>
          <a href="#how" className="hover:text-foreground">
            How it works
          </a>
          <a href="#scoring" className="hover:text-foreground">
            Scoring model
          </a>
          <a href="#security" className="hover:text-foreground">
            Security
          </a>
          <a href="#faq" className="hover:text-foreground">
            FAQ
          </a>
        </nav>
        <div className="flex items-center gap-2.5">
          <a
            href="https://yavar.ai/contact/"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:block"
          >
            Book a demo
          </a>
          <a
            href="#signin"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Sign in
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="dotted-canvas border-b border-border">
      <div className="mx-auto grid max-w-[1200px] gap-12 px-5 py-16 lg:grid-cols-[1.15fr_1fr] lg:py-20">
        <div className="max-w-2xl space-y-7">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Enterprise recruiting operating system
          </span>
          <h1 className="text-4xl font-semibold leading-[1.12] xl:text-5xl">
            <span className="text-primary">Recruiting infrastructure</span> for high-performance
            hiring teams.
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            ATSIQ connects source-aware intake, live market benchmarking, explainable matching,
            guided screening, recruiter collaboration and leadership governance. Every hiring
            decision stays attached to one organisation-safe, auditable record.
          </p>
          <ul className="grid gap-2.5">
            {HERO_PROOF.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-sm text-foreground/80">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                {p}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="#signin"
              className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started
            </a>
            <a
              href="https://yavar.ai/contact/"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Book a demo
            </a>
          </div>
          <div className="grid grid-cols-3 gap-4 border-t border-border pt-6">
            {STATS.map((s) => (
              <div key={s.label}>
                <p className="num text-2xl font-semibold text-primary">{s.value}</p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div id="signin" className="scroll-mt-24">
          <SignInCard />
        </div>
      </div>
    </section>
  );
}

/** Short brand film — the platform in motion, in the yavar.ai visual language. */
function PlatformFilm() {
  return (
    <section className="border-b border-border bg-surface-2">
      <div className="mx-auto max-w-[1200px] px-5 py-14">
        <div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              &bull; Executive intelligence in motion
            </p>
            <h2 className="mt-3 text-2xl font-semibold">
              From hiring evidence to organisational capability
            </h2>
          </div>
        </div>
        <figure className="mt-8 overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_60px_-30px_rgba(17,17,19,0.35)]">
          <video
            className="block h-auto w-full"
            src="/atsiq-landing-film-60s.mp4"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        </figure>
      </div>
    </section>
  );
}

function TrustStrip() {
  return (
    <div className="border-b border-border bg-surface-2">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-4 text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-[0.18em]">
          Built for enterprise hiring teams
        </span>
        <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span>Multi-tenant</span>
          <span>Role-based access</span>
          <span>Row-level security</span>
          <span>Approval workflows</span>
          <span>Audit trail on every decision</span>
          <span>Bring your own AI key</span>
        </span>
      </div>
    </div>
  );
}

function PainOutcomes() {
  return (
    <section className="border-b border-border bg-surface-2">
      <div className="mx-auto max-w-[1200px] px-5 py-16">
        <SectionHead
          eyebrow="Why ATSIQ"
          title="Fix the failure points between demand and joining"
          body="Enterprise hiring does not fail because teams lack another tracker. It fails when evidence, ownership and accountability break between stages."
        />
        <div className="mt-10 divide-y divide-border border-y border-border">
          {PAIN_OUTCOMES.map((item, index) => (
            <article
              key={item.pain}
              className="grid gap-3 py-5 md:grid-cols-[2rem_0.9fr_1fr] md:items-start md:gap-6"
            >
              <span className="num text-xs font-semibold text-primary">0{index + 1}</span>
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">The pain</p>
                <h3 className="mt-1 text-base font-semibold">{item.pain}</h3>
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-primary">The outcome</p>
                <p className="mt-1 text-sm font-semibold">{item.outcome}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
        &bull; {eyebrow}
      </p>
      <h2 className="mt-3 text-3xl font-semibold">{title}</h2>
      {body ? <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p> : null}
    </div>
  );
}

function Capabilities() {
  return (
    <section id="capabilities" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto max-w-[1200px] px-5 py-16">
        <SectionHead
          eyebrow="Capabilities"
          title="An enterprise recruiting OS, not another applicant list"
          body="One operating layer for hiring demand, talent intelligence, human decisions, team accountability and executive governance."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <article key={c.title} className="panel p-5">
              <c.icon className="h-5 w-5 text-primary" />
              <h3 className="mt-3 text-sm font-semibold">{c.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{c.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-b border-border bg-surface-2">
      <div className="mx-auto max-w-[1200px] px-5 py-16">
        <SectionHead
          eyebrow="How it works"
          title="From organisation setup to joining, in five stages"
          body="Each stage writes to the same record, so reporting and audit never need reconciliation."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {MODULES.map((m) => (
            <article key={m.step} className="panel flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between">
                <span className="num text-xs font-semibold text-primary">{m.step}</span>
                <m.icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <h3 className="text-sm font-semibold">{m.title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{m.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScoringModel() {
  return (
    <section id="scoring" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto grid max-w-[1200px] gap-10 px-5 py-16 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            &bull; Scoring model
          </p>
          <h2 className="text-3xl font-semibold">
            A match score you can defend in a review meeting
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every candidate is scored out of 100 across six dimensions. The weights are visible,
            configurable per organisation, and the AI returns the evidence it used for each
            dimension — the CV lines, the public profile it verified, and what it could not confirm.
          </p>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            <li className="flex items-start gap-2.5">
              <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Frontier large language models, powered by your organisation&rsquo;s own API key.
            </li>
            <li className="flex items-start gap-2.5">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Social claims are fetched and verified, not taken on trust.
            </li>
            <li className="flex items-start gap-2.5">
              <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Logistics and risk factors surface as flags — they never silently change a score.
            </li>
          </ul>
        </div>

        <div className="panel divide-y divide-border">
          {WEIGHTS.map((w) => (
            <div key={w.label} className="grid grid-cols-[1fr_auto] items-start gap-4 p-4">
              <div>
                <p className="text-sm font-medium">{w.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{w.note}</p>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(w.value / 40) * 100}%` }}
                  />
                </div>
              </div>
              <span className="num text-sm font-semibold text-primary">{w.value}%</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Governance() {
  return (
    <section
      id="security"
      className="scroll-mt-20 border-b border-border bg-sidebar text-sidebar-foreground"
    >
      <div className="mx-auto max-w-[1200px] px-5 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-primary">
            &bull; Security &amp; governance
          </p>
          <h2 className="mt-3 text-3xl font-semibold">
            Enterprise controls, not bolted-on afterwards
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-sidebar-foreground/70">
            Organisations are approved before they operate, users exist only inside a tenant, and
            every consequential action is recorded.
          </p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {GOVERNANCE.map((g) => (
            <article key={g.title} className="rounded-lg border border-sidebar-border p-5">
              <g.icon className="h-5 w-5 text-sidebar-primary" />
              <h3 className="mt-3 text-sm font-semibold">{g.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-sidebar-foreground/65">{g.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto max-w-[1200px] px-5 py-16">
        <SectionHead eyebrow="FAQ" title="Questions HR leaders ask first" />
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {FAQ.map((f) => (
            <article key={f.q} className="panel p-5">
              <h3 className="text-sm font-semibold">{f.q}</h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.a}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="bg-surface-2">
      <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-6 px-5 py-14 md:flex-row md:items-center">
        <div>
          <h2 className="text-2xl font-semibold">Register your organisation on ATSIQ</h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Registration takes a work email. A platform administrator approves your organisation,
            then you configure departments, locations and invite your internal hiring team.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="#signin"
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </a>
          <a
            href="https://yavar.ai/contact/"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Book a demo
          </a>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- sign-in UI */

function SignInCard() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        await loginRequest(email, password);
        // Cookie is set httpOnly by the server; a reload lets AuthGate pick up
        // the session, exactly like the old onAuthStateChange behaviour.
        window.location.assign("/");
      } else {
        const problem = workEmailProblem(email);
        if (problem) throw new Error(problem);
        const policyProblem = passwordProblem(password);
        if (policyProblem) throw new Error(policyProblem);
        const message = await registerRequest(email, password);
        toast.success(message);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel w-full space-y-5 p-7 shadow-lg lg:sticky lg:top-24">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">
          {mode === "signin" ? "Sign in to ATSIQ" : "Register your organisation"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {mode === "signin"
            ? "Use the work email your organisation invited."
            : "Accounts exist only inside an organisation. Register your company here; a platform administrator approves it, then you invite your internal users."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <PasswordInput
          id="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "signup" ? (
          <p className="text-xs text-muted-foreground">{PASSWORD_POLICY_HINT}</p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create organisation account"}
      </Button>

      {mode === "signin" ? (
        <button
          type="button"
          className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={async () => {
            if (!email.trim()) {
              toast.error("Enter your work email first.");
              return;
            }
            setBusy(true);
            try {
              toast.success(await requestResetRequest(email));
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Forgot your password?
        </button>
      ) : null}

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          or
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        className="w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        onClick={async () => {
          // Registering a new company always starts from a clean session, so the
          // wizard can never be masked by a previously signed-in workspace.
          if (mode === "signin") await signOutApp();
          setMode(mode === "signin" ? "signup" : "signin");
        }}
      >
        {mode === "signin"
          ? "New company? Register your organisation"
          : "Already have an account? Sign in"}
      </button>
    </form>
  );
}
