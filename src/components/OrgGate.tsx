import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSignature } from "lucide-react";
import { toast } from "sonner";

import { signOutApp } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/hooks/useOrg";
import { usePlatform } from "@/hooks/usePlatform";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { isPublicPath } from "@/lib/public-paths";
import { AgreementFields } from "@/components/AgreementFields";
import { EMPTY_AGREEMENT, agreementMissing, agreementPayload } from "@/lib/legal/acceptance";
import { acceptOrgAgreements, myOrgAgreements } from "@/lib/org-agreements.functions";
import type { AgreementKind } from "@/lib/legal/agreements";

/**
 * Nothing in the ATS exists outside an organisation, so a signed-in user with no
 * membership is sent through onboarding before the workspace renders.
 */
export function OrgGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { org, membership, isLoading, isError, error, refetch } = useOrg();
  const platform = usePlatform();
  const fetchAgreements = useServerFn(myOrgAgreements);
  const agreementsLive =
    !!org &&
    membership?.status === "active" &&
    (org.status === "active" || org.status === "pending");
  const agreements = useQuery({
    queryKey: ["my_org_agreements"],
    queryFn: () => fetchAgreements({}),
    enabled: agreementsLive,
    staleTime: 60_000,
    // Members waiting on the owner flip into the workspace once they accept.
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && d.outstanding.length && !d.isOwner ? 15_000 : false;
    },
    retry: 3,
  });

  if (isPublicPath(location.pathname)) return <>{children}</>;

  if (isLoading || platform.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading your organisation…
      </div>
    );
  }

  // A failed lookup must never be mistaken for "this user has no organisation" —
  // that is what used to drop a signed-in super user into the registration wizard.
  if (isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <div className="panel max-w-md space-y-2 p-6">
          <h1 className="text-lg font-semibold">Couldn't load your workspace</h1>
          <p className="text-sm text-muted-foreground">{error?.message ?? "Please try again."}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => refetch()}>
            Retry
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await signOutApp();
              window.location.assign("/");
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  // Platform super users administer tenants; they do not belong to one.
  if ((!org || !membership) && (platform.isSuperUser || platform.claimable)) return <>{children}</>;

  if (!org || !membership) return <OnboardingWizard onDone={() => refetch()} />;

  // The organisation must have accepted the current Terms, Privacy Policy and
  // DPA. A super user can still reach the platform console meanwhile.
  const onPlatformConsole = platform.isSuperUser && location.pathname.startsWith("/platform");
  if (agreementsLive && !onPlatformConsole) {
    if (agreements.isLoading) {
      return (
        <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
          Loading your organisation…
        </div>
      );
    }
    if (agreements.isError) {
      return (
        <Waiting
          title="Couldn't check your organisation's agreements"
          body={agreements.error?.message ?? "Please try again."}
          onRefresh={() => agreements.refetch()}
        />
      );
    }
    const outstanding = agreements.data?.outstanding ?? [];
    if (outstanding.length) {
      return agreements.data?.isOwner ? (
        <AcceptAgreements
          orgName={org.legal_name || org.name}
          outstanding={outstanding}
          renewal={Boolean(agreements.data?.lastAcceptedAt)}
        />
      ) : (
        <Waiting
          title="Waiting for your organisation's owner"
          body={`${org.name}'s owner needs to review and accept the current Terms of Service, Privacy Policy and Data Processing Agreement before the workspace opens. This screen updates itself once they have.`}
          onRefresh={() => agreements.refetch()}
        />
      );
    }
  }

  // A super user who owns a pending tenant must still reach the platform
  // console — otherwise the first tenant can never be approved.
  if (org.status === "pending" && !platform.isSuperUser) {
    return (
      <Waiting
        title="Awaiting platform approval"
        body={`${org.name} has been registered and is queued for review. A platform super admin approves or rejects it, and you receive an email either way. This screen updates itself the moment the decision is made — no need to sign out.`}
        onRefresh={() => refetch()}
      />
    );
  }

  if (org.status === "rejected") {
    return (
      <Waiting
        title="Registration not approved"
        body={
          org.rejection_reason ||
          "This organisation registration was not approved by the platform team."
        }
        onRefresh={() => refetch()}
      />
    );
  }

  if (org.status === "archived") {
    return (
      <Waiting
        title={`${org.name} is archived`}
        body="This organisation has been archived. Every record is preserved — a platform super user can restore access."
      />
    );
  }

  if (membership.status === "disabled") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="panel max-w-md space-y-2 p-8 text-center">
          <h1 className="text-lg font-semibold">Access paused</h1>
          <p className="text-sm text-muted-foreground">
            Your access to {org.name} has been paused. Ask an organisation owner to re-enable it.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/** Full-screen status card for tenants that cannot enter the workspace yet. */
function Waiting({
  title,
  body,
  onRefresh,
}: {
  title: string;
  body: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4">
      <div className="panel max-w-md space-y-2 p-6 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <div className="flex gap-2">
        {onRefresh && (
          <Button size="sm" variant="outline" onClick={onRefresh}>
            Check status
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await signOutApp();
            window.location.assign("/");
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** Owner-only blocking step: accept the current versions the organisation has not accepted. */
function AcceptAgreements({
  orgName,
  outstanding,
  renewal,
}: {
  orgName: string;
  outstanding: AgreementKind[];
  renewal: boolean;
}) {
  const qc = useQueryClient();
  const accept = useServerFn(acceptOrgAgreements);
  const [draft, setDraft] = useState(EMPTY_AGREEMENT);
  const [busy, setBusy] = useState(false);
  const gaps = agreementMissing(draft);

  async function submit() {
    setBusy(true);
    try {
      await accept({ data: agreementPayload(draft) });
      await qc.invalidateQueries({ queryKey: ["my_org_agreements"] });
      toast.success("Thank you — the acceptance is recorded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the acceptance");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="panel w-full max-w-2xl space-y-5 p-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            <FileSignature className="size-4" /> Organisation agreements
          </div>
          <h1 className="text-lg font-semibold">
            {renewal ? "Updated documents to accept" : "Accept ATSIQ's terms for your organisation"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {renewal
              ? "Some of the documents your organisation accepted have a new version. As the owner, review and accept them to keep using the workspace — your team is waiting on this step."
              : "Your organisation has not yet recorded its acceptance of these documents. As the owner, review and accept them to open the workspace for your team."}
          </p>
        </div>
        <AgreementFields value={draft} onChange={setDraft} kinds={outstanding} orgName={orgName} />
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await signOutApp();
              window.location.assign("/");
            }}
          >
            Sign out
          </Button>
          <div className="flex items-center gap-3">
            {gaps.length ? (
              <p className="text-xs text-muted-foreground">Still needed: {gaps.join(", ")}</p>
            ) : null}
            <Button disabled={busy || gaps.length > 0} onClick={submit}>
              {busy ? "Recording…" : "Accept and continue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
