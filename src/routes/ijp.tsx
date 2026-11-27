import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Building2 } from "lucide-react";

import {
  applicationsQuery,
  candidatesQuery,
  departmentsQuery,
  requisitionsQuery,
} from "@/lib/data";
import { requireRouteCapability } from "@/lib/route-guard";
import { applyInternally } from "@/lib/requisitions.functions";
import { EmptyState, PageHeader, SkillPills, inr } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/ijp")({
  beforeLoad: requireRouteCapability,
  head: () => ({
    meta: [
      { title: "Internal Job Postings (IJP) — Talent Acquisition" },
      {
        name: "description",
        content:
          "Internal job board: approved requisitions opened to employees, with internal applications flowing into the same JD↔CV scoring pipeline.",
      },
      { property: "og:title", content: "Internal Job Postings (IJP)" },
      {
        property: "og:description",
        content:
          "Employees apply internally; applications are tagged as IJP and scored against the approved JD.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Ijp,
});

function Ijp() {
  const qc = useQueryClient();
  const reqs = useQuery(requisitionsQuery);
  const depts = useQuery(departmentsQuery);
  const apps = useQuery(applicationsQuery);
  const cands = useQuery(candidatesQuery);

  const [openReq, setOpenReq] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    employee_id: "",
    current_department: "",
    experience_years: "0",
    skills: "",
    note: "",
  });

  const posted = (reqs.data ?? []).filter((r) => r.ijp_enabled && r.status === "approved");
  const internalApps = (apps.data ?? []).filter((a) => a.source === "ijp");

  async function apply() {
    if (!openReq) return;
    if (!form.full_name.trim() || !form.email.trim() || !form.employee_id.trim()) {
      toast.error("Name, work email and employee ID are required");
      return;
    }
    setBusy(true);
    try {
      await applyInternally({
        data: {
          requisitionId: openReq,
          fullName: form.full_name,
          email: form.email,
          employeeId: form.employee_id,
          currentDepartment: form.current_department,
          experienceYears: form.experience_years,
          skills: form.skills,
          note: form.note,
        },
      });

      toast.success("Internal application submitted — it now sits in the requisition pipeline");
      setOpenReq(null);
      setForm({
        full_name: "",
        email: "",
        employee_id: "",
        current_department: "",
        experience_years: "0",
        skills: "",
        note: "",
      });
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["candidates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Application failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Internal mobility"
        title="Internal job postings (IJP)"
        description="Approved requisitions published to employees first. Internal applicants are tagged as IJP and scored against the same approved JD as external CVs."
      />

      <section className="panel p-5">
        <div className="flex items-center gap-2">
          <Building2 className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Internal applications</h2>
        </div>
        <p className="num mt-1 text-xs text-muted-foreground">
          {internalApps.length} internal application(s) · {posted.length} requisition(s) currently
          open to employees
        </p>
      </section>

      {posted.length === 0 ? (
        <EmptyState
          title="No requisitions published internally"
          hint="Open a requisition after approval and switch on 'Publish as internal job posting (IJP)'."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {posted.map((r) => {
            const dept = (depts.data ?? []).find((d) => d.id === r.department_id);
            const applicants = internalApps.filter((a) => a.requisition_id === r.id);
            return (
              <section key={r.id} className="panel p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="num text-xs text-muted-foreground">{r.code}</p>
                    <h3 className="truncate font-semibold">{r.title}</h3>
                    <p className="num text-xs text-muted-foreground">
                      {dept?.name ?? "Unassigned"} · {r.location ?? "—"} · {r.experience_min}–
                      {r.experience_max} yrs · {inr(Number(r.budget_ctc))}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => setOpenReq(r.id)}>
                    Apply internally
                  </Button>
                </div>
                {r.ijp_notes ? <p className="mt-3 text-sm">{r.ijp_notes}</p> : null}
                <div className="mt-3">
                  <SkillPills skills={r.must_have_skills.slice(0, 6)} tone="match" />
                </div>
                <p className="num mt-3 text-xs text-muted-foreground">
                  {applicants.length} internal applicant(s) ·{" "}
                  {r.ijp_posted_at
                    ? `posted ${new Date(r.ijp_posted_at).toLocaleDateString()}`
                    : "posted"}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to="/requisitions/$id" params={{ id: r.id }}>
                      View requisition
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to="/matching" search={{ req: r.id }}>
                      Score applicants
                    </Link>
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {(cands.data ?? []).some((c) => c.is_internal) && (
        <section className="panel p-5">
          <h2 className="font-semibold">Registered internal applicants</h2>
          <ul className="mt-3 divide-y divide-border text-sm">
            {(cands.data ?? [])
              .filter((c) => c.is_internal)
              .map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <Link
                    to="/candidates/$id"
                    params={{ id: c.id }}
                    className="min-w-0 hover:underline"
                  >
                    <span className="font-medium">{c.full_name}</span>
                    <span className="num ml-2 text-xs text-muted-foreground">
                      {c.employee_id ?? "—"} · {c.current_department ?? "—"}
                    </span>
                  </Link>
                  <span className="num text-xs text-muted-foreground">
                    {c.experience_years} yrs
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <Dialog open={Boolean(openReq)} onOpenChange={(o) => !o && setOpenReq(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Apply to an internal posting</DialogTitle>
            <DialogDescription>
              Employee applications enter the same pipeline as external candidates and are scored
              against the approved JD.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["full_name", "Employee name"],
                ["email", "Work email"],
                ["employee_id", "Employee ID"],
                ["current_department", "Current department"],
                ["experience_years", "Total experience (yrs)"],
                ["skills", "Skills (comma separated)"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className={key === "skills" ? "sm:col-span-2" : undefined}>
                <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
                <Input
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="sm:col-span-2">
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                Why this move (used as the profile text for scoring)
              </Label>
              <Textarea
                rows={5}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenReq(null)}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={busy}>
              {busy ? "Submitting…" : "Submit application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
