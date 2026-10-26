import { Link } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { InterviewerProfileCell } from "@/components/InterviewerProfileCell";
import { listInterviewerProfiles } from "@/lib/interviewers.functions";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Crown,
  Download,
  Mail,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  inviteMember,
  listMembers,
  removeMember,
  setMemberRole,
  setMemberStatus,
  updateMember,
  type AppRole,
  type OrgMember,
} from "@/lib/org.functions";
import { useOrg } from "@/hooks/useOrg";
import { EmptyState, PageHeader, StatCard } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/team")({
  head: () => ({
    meta: [
      { title: "Users, roles & access control — Talent Acquisition" },
      {
        name: "description",
        content:
          "Enterprise user administration: search the roster, filter by role or status, grant approval roles, pause access and permanently delete members.",
      },
      { property: "og:title", content: "Users, roles & access control" },
      {
        property: "og:description",
        content:
          "Searchable, filterable roster with bulk role, access and deletion controls for the approval chain.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Team,
});

const ROLE_LABELS: { role: AppRole; label: string; short: string; hint: string }[] = [
  {
    role: "recruiter",
    label: "Recruiter",
    short: "REC",
    hint: "Raises requisitions, sources and scores candidates",
  },
  {
    role: "hiring_manager",
    label: "Hiring manager",
    short: "HM",
    hint: "Runs interviews and evaluations",
  },
  {
    role: "department_head",
    label: "Department head",
    short: "DH",
    hint: "First approval hop on a requisition",
  },
  { role: "hr_head", label: "HR head", short: "HRH", hint: "Second approval hop; offer approval" },
  {
    role: "president_cbo",
    label: "President / CBO",
    short: "CBO",
    hint: "Final approval; manages roles",
  },
];

const PAGE_SIZES = [25, 50, 100, 250];

function roleLabel(role: AppRole) {
  return ROLE_LABELS.find((r) => r.role === role)?.label ?? role;
}

function Team() {
  const qc = useQueryClient();
  const { org, isOwner, roles: myRoles, isLoading } = useOrg();
  // The owner and any President/CBO admin can invite people and change roles.
  const canAdmin = isOwner || myRoles.includes("president_cbo");
  const fetchMembers = useServerFn(listMembers);
  const invite = useServerFn(inviteMember);
  const grant = useServerFn(setMemberRole);
  const status = useServerFn(setMemberStatus);
  const remove = useServerFn(removeMember);
  const editUser = useServerFn(updateMember);

  const [busy, setBusy] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AppRole>("recruiter");
  const [title, setTitle] = useState("");

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "invited" | "disabled">(
    "all",
  );
  const [roleFilter, setRoleFilter] = useState<"all" | AppRole | "none">("all");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const [edit, setEdit] = useState<{
    id: string;
    fullName: string;
    title: string;
    email: string;
    claimed: boolean;
  } | null>(null);

  const members = useQuery({ queryKey: ["org_members"], queryFn: () => fetchMembers({}) });
  // Who interviews, on what (docs/interview-panel-plan.md).
  const fetchInterviewers = useServerFn(listInterviewerProfiles);
  const interviewerRows = useQuery({
    queryKey: ["interviewer_profiles"],
    queryFn: () => fetchInterviewers(),
  });
  const interviewers = new Map(
    (interviewerRows.data ?? []).map((r) => [r.memberId, r.profile] as const),
  );
  const canManageInterviewers = canAdmin || myRoles.includes("hr_head");
  const all = members.data ?? [];

  const rolesOf = (m: OrgMember) => (m.userId ? m.roles : m.invitedRole ? [m.invitedRole] : []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((m) => {
      if (statusFilter !== "all" && m.status !== statusFilter) return false;
      const rs = rolesOf(m);
      if (roleFilter === "none" && rs.length) return false;
      if (roleFilter !== "all" && roleFilter !== "none" && !rs.includes(roleFilter)) return false;
      if (!needle) return true;
      return [m.fullName, m.email, m.title].some((v) => (v ?? "").toLowerCase().includes(needle));
    });
  }, [all, q, statusFilter, roleFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const rows = filtered.slice(current * pageSize, current * pageSize + pageSize);
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const deletableSelected = selectedIds.filter((id) => {
    const m = all.find((x) => x.id === id);
    return m && !m.isOwner;
  });

  const kpis = useMemo(
    () => ({
      total: all.length,
      active: all.filter((m) => m.status === "active").length,
      invited: all.filter((m) => m.status === "invited").length,
      disabled: all.filter((m) => m.status === "disabled").length,
      unassigned: all.filter((m) => rolesOf(m).length === 0).length,
    }),
    [all],
  );

  function refresh() {
    qc.invalidateQueries({ queryKey: ["org_members"] });
    qc.invalidateQueries({ queryKey: ["my_org"] });
  }

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      refresh();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function deleteMembers(ids: string[]) {
    setBusy("delete");
    let done = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await remove({ data: { memberId: id } });
        done += 1;
      } catch (e) {
        failures.push(e instanceof Error ? e.message : "failed");
      }
    }
    setSelected({});
    setConfirmDelete(null);
    setBusy(null);
    refresh();
    if (done) toast.success(`${done} user${done === 1 ? "" : "s"} deleted permanently`);
    if (failures.length) toast.error(failures[0]);
  }

  function exportCsv() {
    const head = ["Name", "Email", "Title", "Status", "Roles", "Joined"];
    const lines = filtered.map((m) =>
      [
        m.fullName ?? "",
        m.email,
        m.title ?? "",
        m.status,
        rolesOf(m).map(roleLabel).join(" / "),
        m.joinedAt ? new Date(m.joinedAt).toISOString().slice(0, 10) : "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const url = URL.createObjectURL(
      new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "users.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="panel mb-4 flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
        <span className="text-muted-foreground">
          Finish setting up your organisation — profile, currency and careers inbox.
        </span>
        <Button asChild size="sm" variant="outline">
          <Link to="/organisation">Open organisation</Link>
        </Button>
      </div>
      <PageHeader
        eyebrow="Administration"
        title="Users, roles & access control"
        description={
          org
            ? `${org.name} roster. Approval chain is role-gated: Department Head → HR Head → President/CBO.`
            : "Organisation roster and approval roles."
        }
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={!filtered.length}>
              <Download className="size-4" /> Export CSV
            </Button>
            {canAdmin ? (
              <Button onClick={() => setShowInvite((v) => !v)}>
                <Plus className="size-4" /> Invite user
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total users" value={kpis.total} />
        <StatCard label="Active" value={kpis.active} tone="success" />
        <StatCard label="Invited" value={kpis.invited} tone="warning" />
        <StatCard label="Paused" value={kpis.disabled} tone="destructive" />
        <StatCard label="No role" value={kpis.unassigned} hint="Cannot approve anything yet" />
      </div>

      {canAdmin && showInvite ? (
        <section className="panel space-y-3 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Mail className="size-4 text-muted-foreground" /> Invite a colleague
          </h2>
          <p className="text-xs text-muted-foreground">
            They join this organisation with the role you pick, the first time they sign in with
            this email address.
          </p>
          <form
            className="grid gap-2 sm:grid-cols-[1.5fr_1fr_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                "invite",
                async () => {
                  await invite({ data: { email, role, title, fullName: "" } });
                  setEmail("");
                  setTitle("");
                },
                "Invitation added to the roster",
              );
            }}
          >
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as AppRole)}
            >
              {ROLE_LABELS.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.label}
                </option>
              ))}
            </select>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional)"
            />
            <Button type="submit" disabled={busy === "invite"}>
              <Plus className="size-4" /> Invite
            </Button>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="Search name, email or title"
              className="pl-8"
            />
          </div>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as typeof statusFilter);
              setPage(0);
            }}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="disabled">Paused</option>
          </select>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value as typeof roleFilter);
              setPage(0);
            }}
          >
            <option value="all">All roles</option>
            {ROLE_LABELS.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
            <option value="none">No role</option>
          </select>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          {isOwner && deletableSelected.length ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                setConfirmDelete({
                  ids: deletableSelected,
                  label: `${deletableSelected.length} selected user${deletableSelected.length === 1 ? "" : "s"}`,
                })
              }
            >
              <Trash2 className="size-4" /> Delete {deletableSelected.length}
            </Button>
          ) : null}
        </div>

        {isLoading || members.isLoading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading the roster…</p>
        ) : filtered.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={all.length ? "No users match these filters" : "No members yet"}
              hint={
                all.length
                  ? "Clear the search or filters."
                  : "Invite your HR colleagues by work email."
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="w-10 p-3">
                    <Checkbox
                      checked={rows.length > 0 && rows.every((m) => selected[m.id])}
                      onCheckedChange={(v) => {
                        const next = { ...selected };
                        rows.forEach((m) => {
                          if (v) next[m.id] = true;
                          else delete next[m.id];
                        });
                        setSelected(next);
                      }}
                      aria-label="Select page"
                    />
                  </th>
                  <th className="p-3 text-left font-medium">User</th>
                  <th className="p-3 text-left font-medium">Title</th>
                  <th className="p-3 text-left font-medium">Status</th>
                  <th className="p-3 text-left font-medium">Roles (click to edit)</th>
                  <th className="p-3 text-left font-medium">Interviews</th>
                  <th className="p-3 text-left font-medium">Joined</th>
                  <th className="w-12 p-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const rs = rolesOf(m);
                  return (
                    <tr
                      key={m.id}
                      className="border-t border-border align-middle hover:bg-muted/30"
                    >
                      <td className="p-3">
                        <Checkbox
                          checked={Boolean(selected[m.id])}
                          onCheckedChange={(v) =>
                            setSelected((s) => {
                              const next = { ...s };
                              if (v) next[m.id] = true;
                              else delete next[m.id];
                              return next;
                            })
                          }
                          aria-label={`Select ${m.email}`}
                        />
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {m.isOwner ? (
                            <Crown className="size-4 shrink-0 text-warning" />
                          ) : (
                            <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate font-medium">{m.fullName || m.email}</div>
                            {m.fullName ? (
                              <div className="num truncate text-xs text-muted-foreground">
                                {m.email}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-muted-foreground">{m.title || "—"}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap items-center gap-1">
                          {m.status === "active" ? (
                            <Badge variant="secondary">Active</Badge>
                          ) : m.status === "invited" ? (
                            <Badge variant="outline">Invited</Badge>
                          ) : (
                            <Badge variant="destructive">Paused</Badge>
                          )}
                          {m.isOwner ? <Badge variant="outline">Owner</Badge> : null}
                        </div>
                      </td>
                      <td className="p-3">
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!canAdmin}
                              title={
                                canAdmin
                                  ? "Click to grant or revoke roles"
                                  : "Only the owner or a President/CBO admin can change roles"
                              }
                            >
                              <Pencil className="size-3.5 opacity-60" />
                              {rs.length
                                ? rs
                                    .map((r) => ROLE_LABELS.find((x) => x.role === r)?.short ?? r)
                                    .join(" · ")
                                : "No role"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-80 space-y-2" align="start">
                            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Roles for {m.fullName || m.email}
                            </div>
                            {ROLE_LABELS.map(({ role: r, label, hint }) => {
                              const has = rs.includes(r);
                              return (
                                <div key={r} className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">{label}</div>
                                    <p className="truncate text-xs text-muted-foreground">{hint}</p>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant={has ? "secondary" : "outline"}
                                    disabled={!canAdmin || busy === `${m.id}:${r}`}
                                    onClick={() =>
                                      run(
                                        `${m.id}:${r}`,
                                        () =>
                                          grant({ data: { memberId: m.id, role: r, grant: !has } }),
                                        has ? "Role revoked" : "Role granted",
                                      )
                                    }
                                  >
                                    {has ? "Revoke" : "Grant"}
                                  </Button>
                                </div>
                              );
                            })}
                          </PopoverContent>
                        </Popover>
                      </td>
                      <td className="p-3">
                        <InterviewerProfileCell
                          memberId={m.id}
                          name={m.fullName || m.email}
                          profile={interviewers.get(m.id)}
                          canEdit={canManageInterviewers}
                        />
                      </td>
                      <td className="num p-3 text-muted-foreground">
                        {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            title={
                              m.isOwner
                                ? "Transfer ownership before deleting the owner"
                                : "Delete user"
                            }
                            disabled={!isOwner || m.isOwner}
                            onClick={() =>
                              setConfirmDelete({ ids: [m.id], label: m.fullName || m.email })
                            }
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" disabled={!canAdmin || m.isOwner}>
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuLabel className="text-xs">Manage user</DropdownMenuLabel>
                              <DropdownMenuItem
                                onClick={() =>
                                  setEdit({
                                    id: m.id,
                                    fullName: m.fullName ?? "",
                                    title: m.title ?? "",
                                    email: m.email,
                                    claimed: Boolean(m.userId),
                                  })
                                }
                              >
                                <Pencil className="size-4" /> Edit details
                              </DropdownMenuItem>
                              {m.userId ? (
                                <DropdownMenuItem
                                  onClick={() =>
                                    run(
                                      `st:${m.id}`,
                                      () =>
                                        status({
                                          data: {
                                            memberId: m.id,
                                            status: m.status === "disabled" ? "active" : "disabled",
                                          },
                                        }),
                                      m.status === "disabled" ? "Access restored" : "Access paused",
                                    )
                                  }
                                >
                                  {m.status === "disabled" ? (
                                    <>
                                      <Play className="size-4" /> Restore access
                                    </>
                                  ) : (
                                    <>
                                      <Pause className="size-4" /> Pause access
                                    </>
                                  )}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() =>
                                  setConfirmDelete({ ids: [m.id], label: m.fullName || m.email })
                                }
                              >
                                <Trash2 className="size-4" /> Delete user
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3 text-xs text-muted-foreground">
            <span className="num">
              {current * pageSize + 1}–{Math.min(filtered.length, (current + 1) * pageSize)} of{" "}
              {filtered.length}
              {selectedIds.length ? ` · ${selectedIds.length} selected` : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              >
                <ChevronLeft className="size-4" /> Prev
              </Button>
              <span className="num">
                Page {current + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={current >= pageCount - 1}
                onClick={() => setPage(current + 1)}
              >
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <Dialog open={Boolean(edit)} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              {edit?.claimed
                ? "The sign-in email cannot change once the account exists."
                : "The invitation email can still be corrected until they sign up."}
            </DialogDescription>
          </DialogHeader>
          {edit ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Full name</Label>
                <Input
                  value={edit.fullName}
                  onChange={(e) => setEdit({ ...edit, fullName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Title</Label>
                <Input
                  value={edit.title}
                  onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input
                  type="email"
                  disabled={edit.claimed}
                  value={edit.email}
                  onChange={(e) => setEdit({ ...edit, email: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy === "edit"}
              onClick={() =>
                edit &&
                run(
                  "edit",
                  async () => {
                    await editUser({
                      data: {
                        memberId: edit.id,
                        fullName: edit.fullName,
                        title: edit.title,
                        ...(edit.claimed ? {} : { email: edit.email }),
                      },
                    });
                    setEdit(null);
                  },
                  "User updated",
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(confirmDelete)} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes their membership and every granted role in this organisation.
              Requisitions, interviews and evaluation history stay intact. Pause access instead if
              the person may return.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "delete"}
              onClick={(e) => {
                e.preventDefault();
                if (confirmDelete) void deleteMembers(confirmDelete.ids);
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
