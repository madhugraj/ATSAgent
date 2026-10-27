import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, Check, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

import { signOutApp } from "@/lib/auth-client";

import { createOrganization, type AppRole } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AgreementFields } from "@/components/AgreementFields";
import { EMPTY_AGREEMENT, agreementMissing, agreementPayload } from "@/lib/legal/acceptance";

const ROLE_OPTIONS: { role: AppRole; label: string }[] = [
  { role: "recruiter", label: "Recruiter" },
  { role: "hiring_manager", label: "Hiring manager" },
  { role: "department_head", label: "Department head" },
  { role: "hr_head", label: "HR head" },
  { role: "president_cbo", label: "President / CBO (CHRO admin)" },
];

const BANDS = ["1-50", "51-200", "201-1000", "1001-5000", "5001-20000", "20000+"];
const STEPS = ["Organisation", "Departments", "Locations", "Invite your team", "Agreements"];

type DeptDraft = { name: string; headName: string };
type InviteDraft = { email: string; role: AppRole; title: string };

/** Five-step setup that stands up a brand-new organisation from scratch. */
export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const create = useServerFn(createOrganization);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [industry, setIndustry] = useState("");
  const [hqCountry, setHqCountry] = useState("India");
  const [hqCity, setHqCity] = useState("");
  const [employeeBand, setEmployeeBand] = useState(BANDS[2]!);
  const [currency, setCurrency] = useState("INR");
  const [fiscalMonth, setFiscalMonth] = useState(4);
  const [careersEmail, setCareersEmail] = useState("");

  const [departments, setDepartments] = useState<DeptDraft[]>([
    { name: "Engineering", headName: "" },
    { name: "Human Resources", headName: "" },
  ]);
  const [locations, setLocations] = useState<string[]>(["Chennai", "Bengaluru", "Remote"]);
  const [locationDraft, setLocationDraft] = useState("");
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AppRole>("recruiter");
  const [inviteTitle, setInviteTitle] = useState("");
  const [agreement, setAgreement] = useState(EMPTY_AGREEMENT);
  const agreementGaps = agreementMissing(agreement);

  const step0Missing = [
    !name.trim() && "Organisation name",
    !legalName.trim() && "Registered legal name",
    !industry.trim() && "Industry",
    !hqCountry.trim() && "HQ country",
    !hqCity.trim() && "HQ city",
    !currency.trim() && "Reporting currency",
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(careersEmail.trim()) && "A valid careers inbox",
  ].filter(Boolean) as string[];
  const step1Ok = departments.filter((d) => d.name.trim()).length > 0;
  const step2Ok = locations.filter(Boolean).length > 0;
  const canContinue =
    step === 0 ? step0Missing.length === 0 : step === 1 ? step1Ok : step === 2 ? step2Ok : true;

  async function finish() {
    setBusy(true);
    try {
      await create({
        data: {
          name,
          legalName,
          industry,
          hqCountry,
          hqCity,
          employeeBand,
          currency,
          fiscalYearStartMonth: fiscalMonth,
          careersEmail,
          departments: departments.filter((d) => d.name.trim()),
          locations: locations.filter(Boolean),
          invites,
          agreement: agreementPayload(agreement),
        },
      });
      await qc.invalidateQueries();
      toast.success(`${name.trim()} submitted for platform approval.`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the organisation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-5 py-12">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            <Building2 className="size-4" /> Organisation setup
          </div>
          <button
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={async () => {
              await signOutApp();
              window.location.assign("/");
            }}
          >
            Sign out
          </button>
        </div>

        <h1 className="mt-3 text-2xl font-semibold">
          Let's set up your talent acquisition workspace
        </h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Everything you create — requisitions, candidates, scores, offers — lives inside this
          organisation and is visible only to the people you invite.
        </p>

        <ol className="mt-8 flex flex-wrap gap-2">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={
                i === step
                  ? "flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium"
                  : "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground"
              }
            >
              {i < step ? (
                <Check className="size-3 text-success" />
              ) : (
                <span className="num">{i + 1}</span>
              )}
              {label}
            </li>
          ))}
        </ol>

        <section className="panel mt-4 space-y-5 p-6">
          {step === 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Organisation name" required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Technologies"
                />
              </Field>
              <Field label="Registered legal name" required>
                <Input
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="Acme Technologies Pvt Ltd"
                />
              </Field>
              <Field label="Industry" required>
                <Input
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="IT services"
                />
              </Field>
              <Field label="Headcount band">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={employeeBand}
                  onChange={(e) => setEmployeeBand(e.target.value)}
                >
                  {BANDS.map((b) => (
                    <option key={b} value={b}>
                      {b} employees
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="HQ country" required>
                <Input value={hqCountry} onChange={(e) => setHqCountry(e.target.value)} />
              </Field>
              <Field label="HQ city" required>
                <Input
                  value={hqCity}
                  onChange={(e) => setHqCity(e.target.value)}
                  placeholder="Chennai"
                />
              </Field>
              <Field label="Reporting currency" required>
                <Input
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Financial year starts in">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={fiscalMonth}
                  onChange={(e) => setFiscalMonth(Number(e.target.value))}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {new Date(2000, m - 1, 1).toLocaleString("en", { month: "long" })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Careers inbox (used on job posts)" required>
                <Input
                  value={careersEmail}
                  onChange={(e) => setCareersEmail(e.target.value)}
                  placeholder="careers@acme.com"
                />
              </Field>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Departments own requisitions, headcount budgets and the first approval hop. You can
                add more later.
              </p>
              {departments.map((d, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Input
                    value={d.name}
                    placeholder="Department name"
                    onChange={(e) =>
                      setDepartments((prev) =>
                        prev.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                  <Input
                    value={d.headName}
                    placeholder="Department head (optional)"
                    onChange={(e) =>
                      setDepartments((prev) =>
                        prev.map((x, j) => (i === j ? { ...x, headName: e.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDepartments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDepartments((prev) => [...prev, { name: "", headName: "" }])}
              >
                <Plus className="size-4" /> Add department
              </Button>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Hiring locations feed requisitions and the location-fit part of every match score.
              </p>
              <div className="flex flex-wrap gap-2">
                {locations.map((l) => (
                  <span
                    key={l}
                    className="flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-sm"
                  >
                    {l}
                    <button
                      className="text-muted-foreground"
                      onClick={() => setLocations((prev) => prev.filter((x) => x !== l))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = locationDraft.trim();
                  if (v && !locations.includes(v)) setLocations((p) => [...p, v]);
                  setLocationDraft("");
                }}
              >
                <Input
                  value={locationDraft}
                  onChange={(e) => setLocationDraft(e.target.value)}
                  placeholder="Add a location"
                />
                <Button type="submit" variant="outline">
                  Add
                </Button>
              </form>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Invite your HR team by work email. They join this organisation with the role you
                pick the first time they sign in. You keep CHRO admin rights as the creator.
              </p>
              <form
                className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  const email = inviteEmail.trim().toLowerCase();
                  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
                    toast.error("Enter a valid work email");
                    return;
                  }
                  if (invites.some((i) => i.email === email)) return;
                  setInvites((p) => [...p, { email, role: inviteRole, title: inviteTitle.trim() }]);
                  setInviteEmail("");
                  setInviteTitle("");
                }}
              >
                <Input
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@acme.com"
                />
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as AppRole)}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <Input
                  value={inviteTitle}
                  onChange={(e) => setInviteTitle(e.target.value)}
                  placeholder="Title (optional)"
                />
                <Button type="submit" variant="outline">
                  <Plus className="size-4" />
                </Button>
              </form>

              {invites.length ? (
                <ul className="space-y-2">
                  {invites.map((i) => (
                    <li
                      key={i.email}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Users className="size-4 text-muted-foreground" />
                        {i.email}
                        <span className="text-xs text-muted-foreground">
                          {ROLE_OPTIONS.find((r) => r.role === i.role)?.label}
                          {i.title ? ` · ${i.title}` : ""}
                        </span>
                      </span>
                      <button
                        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                        onClick={() => setInvites((p) => p.filter((x) => x.email !== i.email))}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No invites yet — you can add colleagues later too.
                </p>
              )}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your organisation is the controller of the candidate and employee data it brings
                into ATSIQ; Yavar AI processes it on your behalf. Review the documents below — the
                person registering must be authorised to accept them for the organisation.
              </p>
              <AgreementFields
                value={agreement}
                onChange={setAgreement}
                orgName={legalName || name}
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button
              variant="ghost"
              disabled={step === 0 || busy}
              onClick={() => setStep((s) => s - 1)}
            >
              Back
            </Button>
            {step === 0 && step0Missing.length ? (
              <p className="text-xs text-muted-foreground">
                Still needed: {step0Missing.join(", ")}
              </p>
            ) : null}
            {step === 1 && !step1Ok ? (
              <p className="text-xs text-muted-foreground">Add at least one department.</p>
            ) : null}
            {step === 2 && !step2Ok ? (
              <p className="text-xs text-muted-foreground">Add at least one hiring location.</p>
            ) : null}
            {step === 4 && agreementGaps.length ? (
              <p className="text-xs text-muted-foreground">
                Still needed: {agreementGaps.join(", ")}
              </p>
            ) : null}
            {step < STEPS.length - 1 ? (
              <Button disabled={!canContinue} onClick={() => setStep((s) => s + 1)}>
                Continue
              </Button>
            ) : (
              <Button
                disabled={
                  busy ||
                  step0Missing.length > 0 ||
                  !step1Ok ||
                  !step2Ok ||
                  agreementGaps.length > 0
                }
                onClick={finish}
              >
                {busy ? "Creating…" : "Create organisation"}
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}
