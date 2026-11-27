import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Building2, HandHeart, Inbox, Users } from "lucide-react";

import { requireRouteCapability } from "@/lib/route-guard";
import { useMe } from "@/hooks/useMe";
import { useOrg } from "@/hooks/useOrg";
import {
  candidatesQuery,
  referralsQuery,
  requisitionsQuery,
  talentRequestsQuery,
  talentSuggestionsQuery,
} from "@/lib/data";
import {
  closeTalentRequest,
  createTalentRequest,
  listPoolShares,
  offerPoolShare,
  poolTeam,
  respondPoolShare,
  respondReferral,
  suggestToRequest,
} from "@/lib/collaboration.functions";
import { PageHeader } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/collaboration")({
  beforeLoad: requireRouteCapability,
  head: () => ({
    meta: [
      { title: "Team & sharing — recruiter hand-offs and talent requests" },
      {
        name: "description",
        content:
          "Referral inbox, candidate hand-overs, requests for talent across the recruiting team, and opt-in pool sharing between organisations.",
      },
      { property: "og:title", content: "Team & sharing — recruiter hand-offs and talent requests" },
      {
        property: "og:description",
        content:
          "Recruiter-to-recruiter collaboration: referrals, ownership transfers, talent requests and cross-company pool sharing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Collaboration,
});

function Collaboration() {
  const qc = useQueryClient();
  const me = useMe();
  const { org, isOwner } = useOrg();

  const fetchTeam = useServerFn(poolTeam);
  const fetchShares = useServerFn(listPoolShares);
  const team = useQuery({
    queryKey: ["pool_team"],
    queryFn: () => fetchTeam({}),
    staleTime: 300_000,
  });
  const shares = useQuery({ queryKey: ["pool_shares"], queryFn: () => fetchShares({}) });
  const refs = useQuery(referralsQuery);
  const requests = useQuery(talentRequestsQuery);
  const suggestions = useQuery(talentSuggestionsQuery);
  const cands = useQuery(candidatesQuery);
  const reqs = useQuery(requisitionsQuery);

  const answer = useServerFn(respondReferral);
  const raise = useServerFn(createTalentRequest);
  const close = useServerFn(closeTalentRequest);
  const suggest = useServerFn(suggestToRequest);
  const offer = useServerFn(offerPoolShare);
  const decide = useServerFn(respondPoolShare);

  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [skills, setSkills] = useState("");
  const [note, setNote] = useState("");
  const [reqId, setReqId] = useState("");
  const [partner, setPartner] = useState("");
  const [scope, setScope] = useState("");
  const [pick, setPick] = useState<Record<string, string>>({});

  const members = team.data ?? [];
  const nameOf = (id: string | null) =>
    (id && members.find((m) => m.userId === id)?.name) || (id ? "A colleague" : "Unassigned");
  const candName = (id: string) => cands.data?.find((c) => c.id === id)?.full_name ?? "Candidate";
  const roleName = (id: string | null) => {
    const r = reqs.data?.find((x) => x.id === id);
    return r ? `${r.code} · ${r.title}` : null;
  };

  const inbox = (refs.data ?? []).filter((r) => r.to_user === me.userId && r.status === "pending");
  const sent = (refs.data ?? []).filter((r) => r.from_user === me.userId);
  const openRequests = (requests.data ?? []).filter((r) => r.status === "open");

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["candidate_referrals"] }),
        qc.invalidateQueries({ queryKey: ["talent_requests"] }),
        qc.invalidateQueries({ queryKey: ["talent_request_suggestions"] }),
        qc.invalidateQueries({ queryKey: ["pool_shares"] }),
        qc.invalidateQueries({ queryKey: ["candidates"] }),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team & sharing"
        description={`The pool is shared across ${org?.name ?? "your organisation"}. Ownership, referrals and requests keep it clear who is working on whom.`}
      />

      <section className="panel p-5">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 text-primary" />
          <h2 className="font-semibold">Referrals for you</h2>
          <Badge variant="secondary">{inbox.length}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Accepting makes you the owner and adds the candidate to the role, when one was named.
        </p>
        <ul className="mt-4 space-y-3">
          {inbox.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    to="/candidates/$id"
                    params={{ id: r.candidate_id }}
                    className="font-medium hover:underline"
                  >
                    {candName(r.candidate_id)}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    From {nameOf(r.from_user)}
                    {roleName(r.requisition_id) ? ` · ${roleName(r.requisition_id)}` : ""} ·{" "}
                    {new Date(r.created_at).toLocaleDateString()}
                  </p>
                  {r.note ? <p className="mt-1 text-sm">{r.note}</p> : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run("Referral accepted", () =>
                        answer({ data: { referralId: r.id, accept: true } }),
                      )
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run("Referral declined", () =>
                        answer({ data: { referralId: r.id, accept: false } }),
                      )
                    }
                  >
                    Decline
                  </Button>
                </div>
              </div>
            </li>
          ))}
          {inbox.length === 0 ? (
            <li className="text-sm text-muted-foreground">Nothing waiting for you.</li>
          ) : null}
        </ul>

        {sent.length ? (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">Referrals you sent</p>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {sent.slice(0, 6).map((r) => (
                <li key={r.id}>
                  {candName(r.candidate_id)} → {nameOf(r.to_user)} · {r.status}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="panel p-5">
        <div className="flex items-center gap-2">
          <HandHeart className="size-4 text-primary" />
          <h2 className="font-semibold">Requests for talent</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask the team for people you cannot find yourself; anyone can suggest a candidate from the
          pool.
        </p>

        <div className="mt-4 grid gap-2 rounded-md border border-border p-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <Label>What do you need?</Label>
            <Input
              className="mt-1"
              placeholder="Senior React engineer, Bengaluru"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <Label>Key skills</Label>
            <Input
              className="mt-1"
              placeholder="react, typescript"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
          </div>
          <div>
            <Label>Role</Label>
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={reqId}
              onChange={(e) => setReqId(e.target.value)}
            >
              <option value="">No specific requisition</option>
              {(reqs.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.title}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <Label>Context</Label>
            <Textarea
              className="mt-1"
              rows={2}
              placeholder="Must be able to join within 30 days…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={busy || title.trim().length < 2}
              onClick={() =>
                run("Request posted to the team", async () => {
                  await raise({
                    data: {
                      title: title.trim(),
                      skills: skills
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                      note: note || undefined,
                      requisitionId: reqId || null,
                    },
                  });
                  setTitle("");
                  setSkills("");
                  setNote("");
                  setReqId("");
                })
              }
            >
              Ask the team
            </Button>
          </div>
        </div>

        <ul className="mt-4 space-y-3">
          {openRequests.map((r) => {
            const mySugs = (suggestions.data ?? []).filter((s) => s.request_id === r.id);
            return (
              <li key={r.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {nameOf(r.requester_id)} · {new Date(r.created_at).toLocaleDateString()}
                      {r.skills.length ? ` · ${r.skills.join(", ")}` : ""}
                      {roleName(r.requisition_id) ? ` · ${roleName(r.requisition_id)}` : ""}
                    </p>
                    {r.note ? <p className="mt-1 text-sm">{r.note}</p> : null}
                  </div>
                  {r.requester_id === me.userId || isOwner ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run("Request closed", () => close({ data: { requestId: r.id } }))
                      }
                    >
                      Close
                    </Button>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <select
                    className="h-9 min-w-56 rounded-md border border-input bg-background px-2 text-sm"
                    value={pick[r.id] ?? ""}
                    onChange={(e) => setPick((p) => ({ ...p, [r.id]: e.target.value }))}
                  >
                    <option value="">Suggest a candidate…</option>
                    {(cands.data ?? []).slice(0, 300).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.full_name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !pick[r.id]}
                    onClick={() =>
                      run("Candidate suggested", async () => {
                        await suggest({ data: { requestId: r.id, candidateId: pick[r.id]! } });
                        setPick((p) => ({ ...p, [r.id]: "" }));
                      })
                    }
                  >
                    Suggest
                  </Button>
                </div>

                {mySugs.length ? (
                  <ul className="mt-2 space-y-1 text-xs">
                    {mySugs.map((s) => (
                      <li key={s.id}>
                        <Link
                          to="/candidates/$id"
                          params={{ id: s.candidate_id }}
                          className="text-primary hover:underline"
                        >
                          {candName(s.candidate_id)}
                        </Link>{" "}
                        <span className="text-muted-foreground">
                          suggested by {nameOf(s.suggested_by)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {openRequests.length === 0 ? (
            <li className="text-sm text-muted-foreground">No open requests.</li>
          ) : null}
        </ul>
      </section>

      <section className="panel p-5">
        <div className="flex items-center gap-2">
          <Building2 className="size-4 text-primary" />
          <h2 className="font-semibold">Sharing with another organisation</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Opt-in only. Nothing is visible to a partner until their owner accepts, and either side
          can stop it at any time. Only share where candidate consent allows it.
        </p>

        {isOwner ? (
          <div className="mt-4 grid gap-2 rounded-md border border-border p-3 md:grid-cols-3">
            <div>
              <Label>Partner organisation</Label>
              <Input
                className="mt-1"
                placeholder="Exact organisation name"
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
              />
            </div>
            <div>
              <Label>What is shared</Label>
              <Input
                className="mt-1"
                placeholder="Engineering candidates only"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                variant="outline"
                disabled={busy || partner.trim().length < 2}
                onClick={() =>
                  run("Sharing offer sent", async () => {
                    await offer({
                      data: { partnerName: partner.trim(), scope: scope || undefined },
                    });
                    setPartner("");
                    setScope("");
                  })
                }
              >
                Offer our pool
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Only an organisation owner can agree to share the pool with another company.
          </p>
        )}

        <ul className="mt-4 space-y-2">
          {(shares.data ?? []).map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <div>
                <p className="text-sm font-medium">{s.partnerName}</p>
                <p className="text-xs text-muted-foreground">
                  {s.direction === "outgoing" ? "We share with them" : "They share with us"} ·{" "}
                  {s.status}
                  {s.scope ? ` · ${s.scope}` : ""}
                </p>
              </div>
              {isOwner ? (
                <div className="flex gap-2">
                  {s.direction === "incoming" && s.status === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          run("Sharing accepted", () =>
                            decide({ data: { shareId: s.id, action: "accept" } }),
                          )
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          run("Sharing declined", () =>
                            decide({ data: { shareId: s.id, action: "decline" } }),
                          )
                        }
                      >
                        Decline
                      </Button>
                    </>
                  ) : null}
                  {s.status === "active" || s.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run("Sharing stopped", () =>
                          decide({ data: { shareId: s.id, action: "revoke" } }),
                        )
                      }
                    >
                      Stop sharing
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
          {(shares.data ?? []).length === 0 ? (
            <li className="text-sm text-muted-foreground">No sharing agreements yet.</li>
          ) : null}
        </ul>
      </section>

      <section className="panel p-5">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <h2 className="font-semibold">Who owns what</h2>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2">Recruiter</th>
                <th className="py-2">Candidates owned</th>
                <th className="py-2">Referrals received</th>
                <th className="py-2">Open requests</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-b border-border/60">
                  <td className="py-2 font-medium">
                    {m.name}
                    {m.userId === me.userId ? " (you)" : ""}
                  </td>
                  <td className="num py-2">
                    {(cands.data ?? []).filter((c) => c.owner_id === m.userId).length}
                  </td>
                  <td className="num py-2">
                    {(refs.data ?? []).filter((r) => r.to_user === m.userId).length}
                  </td>
                  <td className="num py-2">
                    {openRequests.filter((r) => r.requester_id === m.userId).length}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 text-muted-foreground">Unassigned (shared pool)</td>
                <td className="num py-2">{(cands.data ?? []).filter((c) => !c.owner_id).length}</td>
                <td className="py-2" />
                <td className="py-2" />
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
