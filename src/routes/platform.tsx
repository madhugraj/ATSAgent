import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, KeyRound, RotateCcw, Search, Trash2, UserMinus } from "lucide-react";

import {
  addPlatformAdmin,
  claimSuperUser,
  deleteOrgUserAsSuperUser,
  deleteOrganizationAsSuperUser,
  listAllOrganizations,
  listOrgAgreementsAsSuperUser,
  listOrgUsersAsSuperUser,
  listPlatformAdmins,
  removePlatformAdmin,
  reviewOrganization,
  setOrganizationStatus,
  updateOrganizationAsSuperUser,
} from "@/lib/platform.functions";
import { usePlatform } from "@/hooks/usePlatform";
import { AGREEMENT_KINDS, AGREEMENTS } from "@/lib/legal/agreements";
import { EmptyState, PageHeader, StatCard } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/platform")({
  head: () => ({
    meta: [
      { title: "Platform console — registered organisations & usage" },
      {
        name: "description",
        content:
          "Product-owner console: every registered organisation, its members, requisitions, candidates, interviews and hires, with archive, restore and super-user administration.",
      },
      { property: "og:title", content: "Platform console" },
      {
        property: "og:description",
        content:
          "Cross-tenant statistics, archiving and super-user administration for the ATS platform.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Platform,
});

function Platform() {
  const qc = useQueryClient();
  const { isSuperUser, claimable, email, isLoading, refetch } = usePlatform();
  const claim = useServerFn(claimSuperUser);
  const fetchOrgs = useServerFn(listAllOrganizations);
  const fetchAdmins = useServerFn(listPlatformAdmins);
  const addAdmin = useServerFn(addPlatformAdmin);
  const dropAdmin = useServerFn(removePlatformAdmin);
  const setStatus = useServerFn(setOrganizationStatus);
  const review = useServerFn(reviewOrganization);
  const updateOrg = useServerFn(updateOrganizationAsSuperUser);
  const fetchOrgUsers = useServerFn(listOrgUsersAsSuperUser);
  const deleteUser = useServerFn(deleteOrgUserAsSuperUser);
  const dropOrg = useServerFn(deleteOrganizationAsSuperUser);
  const fetchAgreements = useServerFn(listOrgAgreementsAsSuperUser);

  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(true);
  const [adminEmail, setAdminEmail] = useState("");
  const [editOrg, setEditOrg] = useState<{
    id: string;
    name: string;
    industry: string;
    hqCity: string;
    hqCountry: string;
    currency: string;
  } | null>(null);
  const [usersOf, setUsersOf] = useState<{ id: string; name: string } | null>(null);
  const [deleteOrg, setDeleteOrg] = useState<{ id: string; name: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const orgs = useQuery({
    queryKey: ["platform_orgs"],
    queryFn: () => fetchOrgs({}),
    enabled: isSuperUser,
  });
  const admins = useQuery({
    queryKey: ["platform_admins"],
    queryFn: () => fetchAdmins({}),
    enabled: isSuperUser,
  });
  const agreements = useQuery({
    queryKey: ["platform_org_agreements"],
    queryFn: () => fetchAgreements({}),
    enabled: isSuperUser,
  });
  const orgUsers = useQuery({
    queryKey: ["platform_org_users", usersOf?.id],
    queryFn: () => fetchOrgUsers({ data: { orgId: usersOf!.id } }),
    enabled: Boolean(usersOf?.id),
  });

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ["platform_orgs"] });
      qc.invalidateQueries({ queryKey: ["platform_org_agreements"] });
      qc.invalidateQueries({ queryKey: ["platform_admins"] });
      qc.invalidateQueries({ queryKey: ["platform_org_users"] });
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (orgs.data ?? []).filter((o) => {
      if (!showArchived && o.status === "archived") return false;
      if (!needle) return true;
      return [o.name, o.slug, o.industry, o.hqCity, o.hqCountry].some((v) =>
        (v ?? "").toLowerCase().includes(needle),
      );
    });
  }, [orgs.data, q, showArchived]);

  const totals = useMemo(() => {
    const list = orgs.data ?? [];
    const sum = (f: (o: (typeof list)[number]) => number) => list.reduce((a, o) => a + f(o), 0);
    return {
      orgs: list.length,
      active: list.filter((o) => o.status === "active").length,
      users: sum((o) => o.members),
      reqs: sum((o) => o.requisitions),
      candidates: sum((o) => o.candidates),
      hires: sum((o) => o.hires),
    };
  }, [orgs.data]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Checking platform access…</p>;

  if (!isSuperUser) {
    return (
      <>
        <PageHeader
          eyebrow="Platform"
          title="Product owner console"
          description="Cross-organisation visibility."
        />
        <section className="panel max-w-lg space-y-3 p-5">
          {claimable ? (
            <>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="size-4 text-muted-foreground" /> Claim super-user access
              </h2>
              <p className="text-sm text-muted-foreground">
                No super user exists yet. Claiming adds <span className="num">{email}</span> to the
                platform allowlist — you can then add or remove other super users by email.
              </p>
              <Button
                disabled={busy === "claim"}
                onClick={() =>
                  run(
                    "claim",
                    async () => {
                      await claim({});
                      await refetch();
                    },
                    "You are now the platform super user",
                  )
                }
              >
                Claim super-user access
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              This console is restricted to platform super users. Ask an existing super user to add{" "}
              <span className="num">{email}</span> to the allowlist.
            </p>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Registered organisations"
        description="Every tenant on the platform, with live usage. Archiving locks members out and keeps all records."
      />

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Organisations" value={totals.orgs} hint={`${totals.active} active`} />
        <StatCard label="Users" value={totals.users} />
        <StatCard label="Requisitions" value={totals.reqs} />
        <StatCard label="Candidates" value={totals.candidates} />
        <StatCard label="Hires" value={totals.hires} />
        <StatCard label="Super users" value={(admins.data ?? []).length} />
      </div>

      <PendingQueue
        orgs={(orgs.data ?? []).filter((o) => o.status === "pending")}
        busy={busy}
        onDecide={(orgId, decision, reason) =>
          run(
            `rev:${orgId}`,
            () => review({ data: { orgId, decision, reason } }),
            decision === "approve" ? "Organisation approved" : "Registration rejected",
          )
        }
      />

      <section className="panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search organisation"
              className="pl-8"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>

        {orgs.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading organisations…</p>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No organisations"
              hint="Tenants appear here as soon as they register."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="p-2.5 text-left font-medium">Organisation</th>
                  <th className="p-2.5 text-left font-medium">Status</th>
                  <th className="p-2.5 text-right font-medium">Users</th>
                  <th className="p-2.5 text-right font-medium">Reqs</th>
                  <th className="p-2.5 text-right font-medium">Open</th>
                  <th className="p-2.5 text-right font-medium">Candidates</th>
                  <th className="p-2.5 text-right font-medium">Interviews</th>
                  <th className="p-2.5 text-right font-medium">Offers</th>
                  <th className="p-2.5 text-right font-medium">Hires</th>
                  <th className="p-2.5 text-left font-medium">Registered</th>
                  <th className="p-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="border-t border-border hover:bg-muted/30">
                    <td className="p-2.5">
                      <div className="font-medium">{o.name}</div>
                      <div className="num text-xs text-muted-foreground">
                        {[o.industry, o.hqCity, o.hqCountry].filter(Boolean).join(" · ") || o.slug}
                      </div>
                    </td>
                    <td className="p-2.5">
                      {o.status === "archived" ? (
                        <Badge variant="destructive">Archived</Badge>
                      ) : o.status === "pending" ? (
                        <Badge variant="outline">Pending approval</Badge>
                      ) : o.status === "rejected" ? (
                        <Badge variant="destructive">Rejected</Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </td>
                    <td className="num p-2.5 text-right">{o.members}</td>
                    <td className="num p-2.5 text-right">{o.requisitions}</td>
                    <td className="num p-2.5 text-right">{o.openRequisitions}</td>
                    <td className="num p-2.5 text-right">{o.candidates}</td>
                    <td className="num p-2.5 text-right">{o.interviews}</td>
                    <td className="num p-2.5 text-right">{o.offers}</td>
                    <td className="num p-2.5 text-right">{o.hires}</td>
                    <td className="num p-2.5 text-xs text-muted-foreground">
                      {new Date(o.createdAt).toLocaleDateString()}
                    </td>
                    <td className="p-2.5">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setEditOrg({
                              id: o.id,
                              name: o.name,
                              industry: o.industry ?? "",
                              hqCity: o.hqCity ?? "",
                              hqCountry: o.hqCountry ?? "",
                              currency: o.currency,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setUsersOf({ id: o.id, name: o.name })}
                        >
                          Users
                        </Button>
                        <Button
                          size="sm"
                          variant={o.status === "archived" ? "secondary" : "destructive"}
                          disabled={busy === `st:${o.id}`}
                          onClick={() =>
                            run(
                              `st:${o.id}`,
                              () =>
                                setStatus({
                                  data: {
                                    orgId: o.id,
                                    status: o.status === "archived" ? "active" : "archived",
                                    reason: "",
                                  },
                                }),
                              o.status === "archived"
                                ? "Organisation restored"
                                : "Organisation archived",
                            )
                          }
                        >
                          {o.status === "archived" ? (
                            <>
                              <RotateCcw className="size-4" /> Restore
                            </>
                          ) : (
                            <>
                              <Archive className="size-4" /> Archive
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          title="Permanently delete this organisation and all of its records"
                          onClick={() => setDeleteOrg({ id: o.id, name: o.name })}
                        >
                          <Trash2 className="size-4" /> Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AgreementsPanel rows={agreements.data ?? []} loading={agreements.isLoading} />

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Super users</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              "add-admin",
              async () => {
                await addAdmin({ data: { email: adminEmail, note: "" } });
                setAdminEmail("");
              },
              "Super user added",
            );
          }}
        >
          <Input
            type="email"
            required
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="owner@yourcompany.com"
            className="max-w-xs"
          />
          <Button type="submit" disabled={busy === "add-admin"}>
            Add super user
          </Button>
        </form>
        <ul className="divide-y divide-border text-sm">
          {(admins.data ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2">
              <span className="num">{a.email}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === `da:${a.id}`}
                onClick={() =>
                  run(`da:${a.id}`, () => dropAdmin({ data: { id: a.id } }), "Super user removed")
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={Boolean(editOrg)} onOpenChange={(o) => !o && setEditOrg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit organisation</DialogTitle>
            <DialogDescription>Correct a tenant's profile as the product owner.</DialogDescription>
          </DialogHeader>
          {editOrg ? (
            <div className="space-y-2">
              <Input
                value={editOrg.name}
                onChange={(e) => setEditOrg({ ...editOrg, name: e.target.value })}
                placeholder="Name"
              />
              <Input
                value={editOrg.industry}
                onChange={(e) => setEditOrg({ ...editOrg, industry: e.target.value })}
                placeholder="Industry"
              />
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  value={editOrg.hqCity}
                  onChange={(e) => setEditOrg({ ...editOrg, hqCity: e.target.value })}
                  placeholder="HQ city"
                />
                <Input
                  value={editOrg.hqCountry}
                  onChange={(e) => setEditOrg({ ...editOrg, hqCountry: e.target.value })}
                  placeholder="HQ country"
                />
                <Input
                  value={editOrg.currency}
                  onChange={(e) => setEditOrg({ ...editOrg, currency: e.target.value })}
                  placeholder="Currency"
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOrg(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy === "edit-org"}
              onClick={() =>
                editOrg &&
                run(
                  "edit-org",
                  async () => {
                    await updateOrg({ data: { orgId: editOrg.id, ...editOrg } });
                    setEditOrg(null);
                  },
                  "Organisation updated",
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(usersOf)} onOpenChange={(o) => !o && setUsersOf(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Users in {usersOf?.name}</DialogTitle>
            <DialogDescription>
              Super-user override: deleting removes the membership and its roles, including owners.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {(orgUsers.data ?? []).map((u) => (
                  <tr key={u.id} className="border-b border-border">
                    <td className="py-2">
                      <div className="font-medium">{u.fullName || u.email}</div>
                      <div className="num text-xs text-muted-foreground">
                        {u.email} · {u.status}
                        {u.isOwner ? " · owner" : ""}
                      </div>
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === `du:${u.id}`}
                        onClick={() =>
                          run(
                            `du:${u.id}`,
                            () => deleteUser({ data: { memberId: u.id } }),
                            "User deleted",
                          )
                        }
                      >
                        <UserMinus className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {orgUsers.isLoading ? (
              <p className="py-2 text-sm text-muted-foreground">Loading users…</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteOrg)}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteOrg(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteOrg?.name}?</DialogTitle>
            <DialogDescription>
              This permanently removes the organisation and every requisition, candidate, interview,
              offer and user record inside it. This cannot be undone — archive instead if you may
              need the data later.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            placeholder={`Type "${deleteOrg?.name ?? ""}" to confirm`}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOrg(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                !deleteOrg ||
                deleteConfirm.trim().toLowerCase() !== deleteOrg.name.trim().toLowerCase() ||
                busy === "del-org"
              }
              onClick={() =>
                run(
                  "del-org",
                  async () => {
                    await dropOrg({ data: { orgId: deleteOrg!.id, confirmName: deleteConfirm } });
                    setDeleteOrg(null);
                    setDeleteConfirm("");
                  },
                  "Organisation deleted permanently",
                )
              }
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** New tenant registrations waiting for a platform super admin decision. */
function PendingQueue({
  orgs,
  busy,
  onDecide,
}: {
  orgs: {
    id: string;
    name: string;
    slug: string;
    industry: string | null;
    hqCity: string | null;
    hqCountry: string | null;
    createdAt: string;
    members: number;
  }[];
  busy: string | null;
  onDecide: (orgId: string, decision: "approve" | "reject", reason: string) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (orgs.length === 0) return null;
  return (
    <section className="panel space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Pending registrations ({orgs.length})</h2>
        <p className="text-xs text-muted-foreground">
          A registered organisation stays locked until it is approved. Only then can its owner
          create internal users.
        </p>
      </div>
      <div className="space-y-2">
        {orgs.map((o) => (
          <div
            key={o.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5"
          >
            <div className="min-w-[200px] flex-1">
              <div className="text-sm font-medium">{o.name}</div>
              <div className="num text-xs text-muted-foreground">
                {[o.industry, o.hqCity, o.hqCountry].filter(Boolean).join(" · ") || o.slug} ·{" "}
                {new Date(o.createdAt).toLocaleDateString()}
              </div>
            </div>
            <Input
              value={reasons[o.id] ?? ""}
              onChange={(e) => setReasons((r) => ({ ...r, [o.id]: e.target.value }))}
              placeholder="Rejection reason (optional)"
              className="w-56"
            />
            <Button
              size="sm"
              disabled={busy === `rev:${o.id}`}
              onClick={() => onDecide(o.id, "approve", "")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy === `rev:${o.id}`}
              onClick={() => onDecide(o.id, "reject", reasons[o.id] ?? "")}
            >
              Reject
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

type AgreementRow = Awaited<ReturnType<typeof listOrgAgreementsAsSuperUser>>[number];

/** Which organisations accepted which Terms / Privacy / DPA version, when and by whom. */
function AgreementsPanel({ rows, loading }: { rows: AgreementRow[]; loading: boolean }) {
  const outstanding = rows.filter((r) => r.outstanding.length > 0 && r.status !== "rejected");
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <section className="panel space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Organisation agreements</h2>
        <p className="text-xs text-muted-foreground">
          Current versions:{" "}
          {AGREEMENT_KINDS.map((k) => `${AGREEMENTS[k].title} ${AGREEMENTS[k].version}`).join(
            " · ",
          )}
          . {outstanding.length} organisation{outstanding.length === 1 ? "" : "s"} still to accept
          the current versions — their owner is asked on next sign-in.
        </p>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading agreements…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No organisations yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-medium">Organisation</th>
                {AGREEMENT_KINDS.map((k) => (
                  <th key={k} className="py-2 pr-3 font-medium">
                    {AGREEMENTS[k].shortTitle}
                  </th>
                ))}
                <th className="py-2 pr-3 font-medium">Last accepted by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const last = r.history[0];
                return (
                  <tr key={r.orgId} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">{r.status}</div>
                    </td>
                    {AGREEMENT_KINDS.map((k) => {
                      const latest = r.history.find((h) => h.kind === k);
                      const current = !r.outstanding.includes(k);
                      return (
                        <td key={k} className="py-2 pr-3">
                          {latest ? (
                            <div className="space-y-0.5">
                              <Badge variant={current ? "secondary" : "outline"} className="num">
                                {latest.version}
                                {current ? "" : " · outdated"}
                              </Badge>
                              <div className="text-xs text-muted-foreground">
                                {fmt(latest.acceptedAt)}
                              </div>
                            </div>
                          ) : (
                            <Badge variant="outline">Not accepted</Badge>
                          )}
                        </td>
                      );
                    })}
                    <td className="py-2 pr-3">
                      {last ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer">
                            <span className="text-sm">{last.accepterName}</span>
                            <span className="text-muted-foreground">
                              {" "}
                              · {last.accepterTitle} · {last.accepterEmail}
                            </span>
                          </summary>
                          <ul className="mt-1 space-y-0.5 text-muted-foreground">
                            {r.history.map((h) => (
                              <li key={`${h.kind}:${h.version}`} className="num">
                                {AGREEMENTS[h.kind].shortTitle} {h.version} — {h.accepterName} (
                                {h.accepterEmail}), {fmt(h.acceptedAt)}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
