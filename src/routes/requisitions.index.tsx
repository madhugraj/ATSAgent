import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Clock, Loader2, Trash2, X } from "lucide-react";

import {
  addDepartment as addDepartmentFn,
  createDepartment as createDepartmentFn,
  createRequisition,
  deleteRequisition,
} from "@/lib/requisitions.functions";
import { useRoles } from "@/hooks/useRoles";
import {
  addMasterItem,
  applicationsQuery,
  byKind,
  departmentsQuery,
  jdStatusesQuery,
  latestJdStatusMap,
  masterItemsQuery,
  requisitionsQuery,
  type JdWireStatus,
  type MasterKind,
  type Requisition,
} from "@/lib/data";
import { findDuplicateRequisitions } from "@/lib/jd-dedupe";
import { errorToastMessage } from "@/lib/errors";
import { suggestRoleProfile } from "@/lib/role-profile.functions";
import { EmptyState, PageHeader, SkillPills, StatusBadge, inr } from "@/components/ats";
import { OrgProfileNotice } from "@/components/OrgProfileNotice";
import { MarketBenchmarkPanel } from "@/components/MarketBenchmark";
import { CreatableSelect, MasterSelect, TokenPicker } from "@/components/pickers";
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
  DialogTrigger,
} from "@/components/ui/dialog";
export const Route = createFileRoute("/requisitions/")({
  head: () => ({
    meta: [
      { title: "Manpower Requisitions & JD Library — ATS" },
      {
        name: "description",
        content:
          "Raise manpower requisitions against budgeted headcount, route them through approvals and generate AI-assisted job descriptions.",
      },
      { property: "og:title", content: "Manpower Requisitions & JD Library" },
      {
        property: "og:description",
        content:
          "Budget-aware requisitions with DH/HR/CBO approval trail and AI-drafted job descriptions.",
      },
    ],
  }),
  component: Requisitions,
});

type TrailEntry = {
  from?: string;
  to?: string;
  actor?: string;
  decision?: string;
  comment?: string | null;
  at?: string;
};

/** Mirrors APPROVALS on requisitions.$id.tsx — whose desk each parked status sits on. */
const WAITING_ON: Partial<Record<string, string>> = {
  draft: "Department Head review",
  pending_dh: "Department Head approval",
  pending_hr: "HR Head approval",
  pending_cbo: "President / CBO approval",
};

const JD_CHIP: Record<JdWireStatus, { label: string; className: string }> = {
  draft: {
    label: "JD draft",
    className: "border-border bg-surface-2 text-muted-foreground",
  },
  pending_dh: {
    label: "JD pending DH",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  approved: {
    label: "JD approved",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  changes_requested: {
    label: "JD changes requested",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

/** When the requisition entered its current state (last trail entry, else creation). */
function enteredCurrentStateAt(r: Requisition): string {
  const trail = Array.isArray(r.approval_trail) ? (r.approval_trail as TrailEntry[]) : [];
  const last = trail[trail.length - 1];
  return (last && typeof last.at === "string" && last.at) || r.created_at;
}

function Requisitions() {
  const qc = useQueryClient();
  const { roles, isAdmin } = useRoles();
  const canDeleteDraft = isAdmin || roles.includes("hr_head");
  const [deletingDraft, setDeletingDraft] = useState<{
    id: string;
    code: string;
    reason: string;
  } | null>(null);
  const runDeleteRequisition = useServerFn(deleteRequisition);
  const reqs = useQuery(requisitionsQuery);
  const depts = useQuery(departmentsQuery);
  const apps = useQuery(applicationsQuery);
  const masters = useQuery(masterItemsQuery);
  const jdStatuses = useQuery(jdStatusesQuery);
  const jdMap = useMemo(() => latestJdStatusMap(jdStatuses.data), [jdStatuses.data]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    department_id: "",
    location: "",
    openings: "1",
    experience_min: "3",
    experience_max: "6",
    budget_ctc: "1800000",
    ctc_band_min: "",
    ctc_band_max: "",
    max_notice_period_days: "",
    work_authorization_required: "",
    hiring_manager: "",
    must: [] as string[],
    good: [] as string[],
    responsibilities: "",
    education_requirement: "",
    billing_type: "Non-billable",
    engagement_type: "Internal / Corporate",
    client_name: "",
    cost_center: "",
  });

  const [dupAck, setDupAck] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const draftProfile = useServerFn(suggestRoleProfile);
  const requisitions = reqs.data ?? [];
  const departments = depts.data ?? [];
  const skills = byKind(masters.data, "skill");
  const locations = byKind(masters.data, "location");
  const education = byKind(masters.data, "education");
  const roleTitles = byKind(masters.data, "role_title");
  const billingTypes = byKind(masters.data, "billing_type");
  const engagementTypes = byKind(masters.data, "engagement_type");
  const clients = byKind(masters.data, "client");

  /**
   * On-the-fly library adds must never block raising the requisition — the
   * typed value stays selected either way — but the user is told when the
   * entry was already in the library or the add genuinely failed, instead of
   * the add silently no-oping.
   */
  async function addToLibrary(kind: MasterKind, name: string) {
    try {
      const res = await addMasterItem(kind, name);
      if (res?.existed) toast.info(`“${name.trim()}” is already in the library`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not add “${name.trim()}” to the library`);
    }
    qc.invalidateQueries({ queryKey: ["master_items"] });
  }

  async function createClient(name: string) {
    await addToLibrary("client", name);
  }

  async function createEducation(name: string) {
    await addToLibrary("education", name);
  }

  async function createSkill(name: string) {
    await addToLibrary("skill", name);
  }

  async function createRoleTitle(name: string) {
    await addToLibrary("role_title", name);
  }

  async function createDepartment(name: string) {
    try {
      const data = await createDepartmentFn({ data: { name: name.trim() } });
      await qc.invalidateQueries({ queryKey: ["departments"] });
      const newId = data?.id;
      if (newId) setForm((f) => ({ ...f, department_id: newId }));
      toast.success(`${name.trim()} added — set its budget below`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the department");
    }
  }

  // Skills and qualifications drafted from the role title. Existing picks are
  // kept — the draft only adds what is missing, and HR can edit everything.
  async function autofillFromRole() {
    if (form.title.trim().length < 2) {
      toast.error("Pick or type the role title first.");
      return;
    }
    setDrafting(true);
    try {
      const out = await draftProfile({
        data: {
          role: form.title,
          department: departments.find((d) => d.id === form.department_id)?.name ?? null,
          location: form.location,
          experienceMin: Number(form.experience_min) || 0,
          experienceMax: Number(form.experience_max) || 0,
        },
      });
      const merge = (current: string[], next: string[]) => {
        const seen = new Set(current.map((s) => s.toLowerCase()));
        return [...current, ...next.filter((s) => !seen.has(s.toLowerCase()))];
      };
      const must = merge(form.must, out.must_have_skills);
      const good = merge(form.good, out.good_to_have_skills).filter(
        (s) => !must.some((m) => m.toLowerCase() === s.toLowerCase()),
      );
      const quals = merge(
        form.education_requirement ? form.education_requirement.split(" | ") : [],
        out.qualifications,
      );
      setForm((f) => ({
        ...f,
        must,
        good,
        education_requirement: quals.join(" | "),
        responsibilities: f.responsibilities.trim() ? f.responsibilities : out.responsibilities,
      }));
      for (const name of [...out.must_have_skills, ...out.good_to_have_skills]) {
        await addMasterItem("skill", name).catch(() => {});
      }
      for (const name of out.qualifications) {
        await addMasterItem("education", name).catch(() => {});
      }
      await qc.invalidateQueries({ queryKey: ["master_items"] });
      toast.success("Role profile drafted — review and edit as needed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not draft the role profile.");
    } finally {
      setDrafting(false);
    }
  }

  // Duplicate-JD guard: an open requisition for the same role in the same
  // department is almost always a mistake, so we surface it before saving.
  const duplicates = useMemo(
    () =>
      findDuplicateRequisitions(
        {
          title: form.title,
          department_id: form.department_id || null,
          location: form.location,
          must_have_skills: form.must,
        },
        requisitions,
      ),
    [form.title, form.department_id, form.location, form.must, requisitions],
  );

  async function create() {
    if (!form.title.trim()) {
      toast.error("Role title is required");
      return;
    }
    if (duplicates.length && !dupAck) {
      setDupAck(true);
      toast.error(
        "A similar open requisition already exists — review it, then confirm to continue.",
      );
      return;
    }
    setSaving(true);
    let code = "Requisition";
    try {
      const res = await createRequisition({
        data: {
          title: form.title,
          departmentId: form.department_id || null,
          location: form.location,
          openings: form.openings,
          experienceMin: form.experience_min,
          experienceMax: form.experience_max,
          budgetCtc: form.budget_ctc,
          ctcBandMin: form.ctc_band_min,
          ctcBandMax: form.ctc_band_max,
          maxNoticePeriodDays: form.max_notice_period_days,
          workAuthorizationRequired: form.work_authorization_required,
          hiringManager: form.hiring_manager,
          mustHaveSkills: form.must,
          goodToHaveSkills: form.good,
          responsibilities: form.responsibilities,
          educationRequirement: form.education_requirement,
          billingType: form.billing_type,
          engagementType: form.engagement_type,
          clientName: form.client_name,
          costCenter: form.cost_center,
        },
      });
      code = res?.code ?? code;
    } catch (e) {
      setSaving(false);
      toast.error(
        errorToastMessage(
          e,
          "Could not raise the requisition — a server error occurred. Try again.",
        ),
      );
      return;
    }
    setSaving(false);
    toast.success(`${code} raised and sent for Department Head approval`);
    setDupAck(false);
    setOpen(false);
    qc.invalidateQueries({ queryKey: ["requisitions"] });
  }

  return (
    <>
      <PageHeader
        eyebrow="Sourcing"
        title="Manpower requisitions"
        description="Every requisition is checked against budgeted headcount and routed through DH → HR → CBO approvals before sourcing starts."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>Raise requisition</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Raise a manpower requisition</DialogTitle>
                <DialogDescription>
                  Skills entered here drive the JD draft and the JD↔CV match scoring.
                </DialogDescription>
              </DialogHeader>
              {duplicates.length ? (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <p className="font-semibold">
                    Possible duplicate requisition{duplicates.length > 1 ? "s" : ""}
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {duplicates.map((d) => (
                      <li key={d.req.id} className="text-xs">
                        <Link
                          to="/requisitions/$id"
                          params={{ id: d.req.id }}
                          className="font-medium underline"
                          onClick={() => setOpen(false)}
                        >
                          {d.req.code} · {d.req.title}
                        </Link>
                        <span className="text-muted-foreground"> — {d.reasons.join(" · ")}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Raise this only if it is genuinely a separate hire (extra headcount, different
                    client or location). Otherwise add openings to the existing requisition.
                  </p>
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Role title" className="sm:col-span-2">
                  <CreatableSelect
                    options={roleTitles}
                    value={form.title}
                    onChange={(v) => setForm({ ...form, title: v })}
                    onCreate={createRoleTitle}
                    placeholder="Search role titles, or type a new one"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={drafting}
                      onClick={autofillFromRole}
                    >
                      {drafting ? "Drafting…" : "Auto-fill skills & qualifications"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Suggests must-have and good-to-have skills, acceptable qualifications and
                      responsibilities for this role — edit anything before saving.
                    </span>
                  </div>
                </Field>
                <Field label="Department">
                  <CreatableSelect
                    options={departments.map((d) => ({ id: d.id, name: d.name }))}
                    value={departments.find((d) => d.id === form.department_id)?.name ?? ""}
                    onChange={(name) =>
                      setForm((f) => ({
                        ...f,
                        department_id: name
                          ? (departments.find((d) => d.name === name)?.id ?? f.department_id)
                          : "",
                      }))
                    }

                    onCreate={createDepartment}
                    placeholder="Search departments, or type a new one"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    New departments start with zero budget — set headcount and cost below.
                  </p>
                </Field>

                <Field label="Locations">
                  <TokenPicker
                    options={locations}
                    value={
                      form.location
                        ? form.location
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                        : []
                    }
                    onChange={(next) => setForm({ ...form, location: next.join(", ") })}
                    onCreate={async (name) => {
                      await addToLibrary("location", name);
                    }}
                    placeholder="Search locations, or type a new one"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Pick one or more locations for this requisition.
                  </p>
                </Field>

                <Field label="Openings">
                  <Input
                    type="number"
                    value={form.openings}
                    onChange={(e) => setForm({ ...form, openings: e.target.value })}
                  />
                </Field>
                <Field label="Budget CTC (₹)">
                  <Input
                    type="number"
                    value={form.budget_ctc}
                    onChange={(e) => setForm({ ...form, budget_ctc: e.target.value })}
                  />
                </Field>
                <Field label="CTC band min (₹)">
                  <Input
                    type="number"
                    value={form.ctc_band_min}
                    onChange={(e) => setForm({ ...form, ctc_band_min: e.target.value })}
                  />
                </Field>
                <Field label="CTC band max (₹)">
                  <Input
                    type="number"
                    value={form.ctc_band_max}
                    onChange={(e) => setForm({ ...form, ctc_band_max: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Used to flag out-of-band expectations — it never lowers a candidate&apos;s match
                    score.
                  </p>
                </Field>
                <div className="sm:col-span-2">
                  <MarketBenchmarkPanel
                    role={form.title}
                    location={form.location}
                    department={departments.find((d) => d.id === form.department_id)?.name ?? null}
                    experienceMin={Number(form.experience_min) || 0}
                    experienceMax={Number(form.experience_max) || 0}
                    skills={[...form.must, ...form.good]}
                    onApply={({ budget, bandMin, bandMax }) => {
                      setForm((f) => ({
                        ...f,
                        budget_ctc: String(budget),
                        ctc_band_min: String(bandMin),
                        ctc_band_max: String(bandMax),
                      }));
                      toast.success("Budget and band filled from the market range.");
                    }}
                  />
                </div>
                <Field label="Max notice period (days)">
                  <Input
                    type="number"
                    value={form.max_notice_period_days}
                    onChange={(e) => setForm({ ...form, max_notice_period_days: e.target.value })}
                  />
                </Field>
                <Field label="Work authorisation required">
                  <Input
                    placeholder="e.g. Indian citizen / H-1B / EU work permit"
                    value={form.work_authorization_required}
                    onChange={(e) =>
                      setForm({ ...form, work_authorization_required: e.target.value })
                    }
                  />
                </Field>
                <Field label="Experience min (yrs)">
                  <Input
                    type="number"
                    value={form.experience_min}
                    onChange={(e) => setForm({ ...form, experience_min: e.target.value })}
                  />
                </Field>
                <Field label="Experience max (yrs)">
                  <Input
                    type="number"
                    value={form.experience_max}
                    onChange={(e) => setForm({ ...form, experience_max: e.target.value })}
                  />
                </Field>
                <Field label="Hiring manager" className="sm:col-span-2">
                  <Input
                    value={form.hiring_manager}
                    onChange={(e) => setForm({ ...form, hiring_manager: e.target.value })}
                  />
                </Field>
                <Field label="Billing type">
                  <MasterSelect
                    options={billingTypes}
                    value={form.billing_type}
                    onChange={(v) => setForm({ ...form, billing_type: v })}
                    placeholder="Billable / Non-billable"
                  />
                </Field>
                <Field label="Engagement type">
                  <MasterSelect
                    options={engagementTypes}
                    value={form.engagement_type}
                    onChange={(v) => setForm({ ...form, engagement_type: v })}
                    placeholder="Client project, R&D, internal…"
                  />
                </Field>
                <Field label="Client / account">
                  <CreatableSelect
                    options={clients}
                    value={form.client_name}
                    onChange={(v) => setForm({ ...form, client_name: v })}
                    onCreate={createClient}
                    placeholder="Only for client-billed roles"
                  />
                </Field>
                <Field label="Cost centre">
                  <Input
                    value={form.cost_center}
                    onChange={(e) => setForm({ ...form, cost_center: e.target.value })}
                    placeholder="e.g. CC-ENG-01"
                  />
                </Field>
                <Field label="Must-have skills" className="sm:col-span-2">
                  <TokenPicker
                    options={skills}
                    value={form.must}
                    onChange={(v) => setForm({ ...form, must: v })}
                    onCreate={createSkill}
                    placeholder="Search the skills library…"
                  />
                </Field>
                <Field label="Good-to-have skills" className="sm:col-span-2">
                  <TokenPicker
                    options={skills}
                    value={form.good}
                    onChange={(v) => setForm({ ...form, good: v })}
                    onCreate={createSkill}
                    placeholder="Search the skills library…"
                  />
                </Field>
                <Field
                  label="Education requirement — any of these qualifies"
                  className="sm:col-span-2"
                >
                  <TokenPicker
                    options={education}
                    value={
                      form.education_requirement ? form.education_requirement.split(" | ") : []
                    }
                    onChange={(v) => setForm({ ...form, education_requirement: v.join(" | ") })}
                    onCreate={createEducation}
                    placeholder="Search qualifications — pick every acceptable degree…"
                  />
                </Field>

                <Field label="Key responsibilities" className="sm:col-span-2">
                  <Textarea
                    rows={4}
                    value={form.responsibilities}
                    onChange={(e) => setForm({ ...form, responsibilities: e.target.value })}
                  />
                </Field>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={create} disabled={saving}>
                  {saving
                    ? "Raising…"
                    : duplicates.length && !dupAck
                      ? "Check duplicates"
                      : duplicates.length
                        ? "Raise anyway & send for approval"
                        : "Raise & send for approval"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="mt-4">
        <OrgProfileNotice />
      </div>

      <DepartmentBudgets />

      {requisitions.length === 0 ? (
        <EmptyState
          title="No requisitions yet"
          hint="Raise your first requisition to start sourcing."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {requisitions.map((r) => {
            const dept = departments.find((d) => d.id === r.department_id);
            const count = (apps.data ?? []).filter((a) => a.requisition_id === r.id).length;
            return (
              <Link
                key={r.id}
                to="/requisitions/$id"
                params={{ id: r.id }}
                className="panel block p-5 transition-colors hover:border-ring"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="num text-xs text-muted-foreground">{r.code}</div>
                    <h3 className="mt-1 text-lg font-semibold">{r.title}</h3>
                    <div className="text-sm text-muted-foreground">
                      {dept?.name ?? "Unassigned"} · {r.location}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      <span
                        className={
                          r.billing_type === "Billable"
                            ? "rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
                            : "rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground"
                        }
                      >
                        {r.billing_type}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {r.engagement_type}
                      </span>
                      {r.client_name ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          {r.client_name}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {(() => {
                      const jd = jdMap.get(r.id);
                      const chip = jd ? JD_CHIP[jd] : null;
                      return chip ? (
                        <span
                          className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.className}`}
                        >
                          {chip.label}
                        </span>
                      ) : (
                        <span className="whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                          No JD yet
                        </span>
                      );
                    })()}
                    <StatusBadge status={r.status} />
                    {r.status === "draft" && canDeleteDraft ? (
                      deletingDraft?.id === r.id ? (
                        <span
                          className="flex items-center gap-1"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                        >
                          <input
                            autoFocus
                            className="h-6 w-36 rounded border border-border bg-background px-1.5 text-[11px]"
                            placeholder="Reason (audit trail)"
                            value={deletingDraft.reason}
                            onChange={(e) =>
                              setDeletingDraft({ ...deletingDraft, reason: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setDeletingDraft(null);
                            }}
                          />
                          <button
                            type="button"
                            className="rounded bg-destructive p-1 text-destructive-foreground disabled:opacity-50"
                            disabled={deleting}
                            title="Delete this draft permanently"
                            onClick={async (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDeleting(true);
                              try {
                                await runDeleteRequisition({
                                  data: {
                                    id: r.id,
                                    reason: deletingDraft.reason.trim() || null,
                                  },
                                });
                                toast.success(`Draft ${r.code} deleted`);
                                setDeletingDraft(null);
                                qc.invalidateQueries({ queryKey: ["requisitions"] });
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Could not delete the draft",
                                );
                              } finally {
                                setDeleting(false);
                              }
                            }}
                          >
                            {deleting ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Check className="size-3" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="rounded border border-border p-1 text-muted-foreground"
                            title="Cancel"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDeletingDraft(null);
                            }}
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="text-muted-foreground/60 transition-colors hover:text-destructive"
                          title="Delete this draft"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeletingDraft({ id: r.id, code: r.code, reason: "" });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )
                    ) : null}
                  </div>
                </div>
                <dl className="num mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Openings</dt>
                    <dd className="font-semibold">{r.openings}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Experience</dt>
                    <dd className="font-semibold">
                      {r.experience_min}–{r.experience_max} yrs
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Budget</dt>
                    <dd className="font-semibold">{inr(Number(r.budget_ctc))}</dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <SkillPills skills={r.must_have_skills.slice(0, 6)} />
                </div>
                {(() => {
                  const waiting = WAITING_ON[r.status];
                  if (!waiting) return null;
                  const days = Math.max(
                    0,
                    Math.floor(
                      (Date.now() - new Date(enteredCurrentStateAt(r)).getTime()) / 86_400_000,
                    ),
                  );
                  return (
                    <p
                      className={`mt-3 flex items-center gap-1.5 text-xs ${
                        days >= 3 ? "font-medium text-warning" : "text-muted-foreground"
                      }`}
                    >
                      <Clock className="size-3.5" />
                      Waiting {days} day{days === 1 ? "" : "s"} — {waiting}
                    </p>
                  );
                })()}
                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Weights — skills {r.weight_skills} · exp {r.weight_experience} · edu{" "}
                    {r.weight_education} · social {r.weight_social}
                  </span>
                  <span className="num">{count} applicants</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

function DepartmentBudgets() {
  const qc = useQueryClient();
  const depts = useQuery(departmentsQuery);
  const [form, setForm] = useState({
    name: "",
    head_name: "",
    budgeted_headcount: "",
    budgeted_cost: "",
  });
  const [saving, setSaving] = useState(false);
  const departments = depts.data ?? [];

  async function addDept() {
    if (!form.name.trim()) {
      toast.error("Department name is required");
      return;
    }
    setSaving(true);
    try {
      await addDepartmentFn({
        data: {
          name: form.name.trim(),
          headName: form.head_name,
          budgetedHeadcount: form.budgeted_headcount,
          budgetedCost: form.budgeted_cost,
        },
      });
    } catch (e) {
      setSaving(false);
      toast.error(e instanceof Error ? e.message : "Could not add the department");
      return;
    }
    setSaving(false);
    toast.success(`${form.name.trim()} added to workforce plan`);
    setForm({ name: "", head_name: "", budgeted_headcount: "", budgeted_cost: "" });
    qc.invalidateQueries({ queryKey: ["departments"] });
  }

  return (
    <section className="panel mb-6 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Departments & budgeted headcount</h2>
        <p className="text-xs text-muted-foreground">
          Requisitions are checked against these budgets. Add your real departments before raising
          requisitions.
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-5">
        <Field label="Department" className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Engineering"
          />
        </Field>
        <Field label="Department head">
          <Input
            value={form.head_name}
            onChange={(e) => setForm({ ...form, head_name: e.target.value })}
          />
        </Field>
        <Field label="Budgeted headcount">
          <Input
            inputMode="numeric"
            value={form.budgeted_headcount}
            onChange={(e) => setForm({ ...form, budgeted_headcount: e.target.value })}
          />
        </Field>
        <Field label="Budgeted cost (₹)">
          <Input
            inputMode="numeric"
            value={form.budgeted_cost}
            onChange={(e) => setForm({ ...form, budgeted_cost: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={addDept} disabled={saving}>
          {saving ? "Adding…" : "Add department"}
        </Button>
      </div>

      {departments.length > 0 && (
        <ul className="mt-4 divide-y border-t text-sm">
          {departments.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-medium">{d.name}</span>
              <span className="num text-xs text-muted-foreground">
                {d.head_name ?? "No head assigned"} · {d.budgeted_headcount} roles ·{" "}
                {inr(Number(d.budgeted_cost))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
