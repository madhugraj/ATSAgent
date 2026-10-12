import { Link } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Archive, Building2 } from "lucide-react";

import { archiveOwnOrganization, updateOrganization } from "@/lib/org.functions";
import { useOrg } from "@/hooks/useOrg";
import { PageHeader } from "@/components/ats";
import { TrainingDataCard } from "@/components/TrainingDataCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function OrganisationSettings() {
  const qc = useQueryClient();
  const { org, isOwner, isLoading, refetch } = useOrg();
  const save = useServerFn(updateOrganization);
  const archive = useServerFn(archiveOwnOrganization);

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

  return (
    <>
      <div className="panel mb-4 flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
        <span className="text-muted-foreground">
          Next setup step: invite your team and assign the approval roles.
        </span>
        <Button asChild size="sm" variant="outline">
          <Link to="/team">Users &amp; roles</Link>
        </Button>
      </div>
      <PageHeader
        eyebrow="Administration"
        title="Organisation"
        description={
          isOwner
            ? "Owner settings for this tenant. Archiving keeps every requisition, candidate and interview record."
            : "Only an organisation owner can change these details."
        }
      />

      <section className="panel space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="size-4 text-muted-foreground" /> Profile
        </h2>
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
              <Input
                id={key}
                disabled={!isOwner}
                value={String(form[key])}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
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
      </section>

      <TrainingDataCard isOwner={Boolean(isOwner)} />

      {isOwner ? (
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
      ) : null}

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
