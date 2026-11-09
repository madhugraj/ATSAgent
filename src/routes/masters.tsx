import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import { addMasterItem, byKind, masterItemsQuery, type MasterKind } from "@/lib/data";
import { deleteMasterItem } from "@/lib/master.functions";
import { PageHeader } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/masters")({
  head: () => ({
    meta: [
      { title: "Master Data — Skills, Locations & Education Library" },
      {
        name: "description",
        content:
          "Maintain your organisation's reference library used across requisitions, JDs and CV matching: role titles, skills taxonomy, locations, education levels, employment types and industries.",
      },
      { property: "og:title", content: "Master Data Library" },
      {
        property: "og:description",
        content:
          "One governed taxonomy of skills, locations and qualifications powering every requisition and match score.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Masters,
});

const GROUPS: { kind: MasterKind; title: string; hint: string; placeholder: string }[] = [
  {
    kind: "role_title",
    title: "Role titles",
    hint: "Standard job titles recruiters pick from when raising a requisition.",
    placeholder: "Senior Backend Engineer",
  },
  {
    kind: "skill",
    title: "Skills taxonomy",
    hint: "Drives requisition must-haves, JD drafting and the 50-point skill match.",
    placeholder: "Kubernetes",
  },

  {
    kind: "education",
    title: "Education / qualifications",
    hint: "Used for the 10-point education dimension.",
    placeholder: "M.Tech",
  },
  {
    kind: "location",
    title: "Locations",
    hint: "Job locations and work models.",
    placeholder: "Ahmedabad",
  },
  {
    kind: "employment_type",
    title: "Employment types",
    hint: "Full-time, contract, internship…",
    placeholder: "Retainer",
  },
  {
    kind: "billing_type",
    title: "Billing types",
    hint: "Billable vs non-billable positions.",
    placeholder: "Partially billable",
  },
  {
    kind: "engagement_type",
    title: "Engagement types",
    hint: "Client project, R&D, internal, pre-sales…",
    placeholder: "Innovation lab",
  },
  {
    kind: "client",
    title: "Clients / accounts",
    hint: "Accounts that billable requisitions map to.",
    placeholder: "Acme Corp",
  },
  {
    kind: "industry",
    title: "Industries",
    hint: "Optional classification for reporting.",
    placeholder: "Logistics",
  },
];

function Masters() {
  const items = useQuery(masterItemsQuery);

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Master data library"
        description="Your organisation's shared lists — every requisition, JD and match score reads from them. Add your own entries any time; recruiters can also add on the fly while raising a requisition."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <MasterCard key={g.kind} group={g} all={items.data} />
        ))}
      </div>
    </>
  );
}

function MasterCard({
  group,
  all,
}: {
  group: { kind: MasterKind; title: string; hint: string; placeholder: string };
  all: ReturnType<typeof byKind> | undefined;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const list = byKind(all, group.kind);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await addMasterItem(group.kind, name, category || null);
      if (res?.existed) {
        toast.info(`“${name.trim()}” is already in this list`);
      } else {
        toast.success(`${name.trim()} added`);
        setName("");
        setCategory("");
      }
      qc.invalidateQueries({ queryKey: ["master_items"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add entry");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This permanently removes it from the library.`)) return;
    try {
      await deleteMasterItem({ data: { id } });
      toast.success(`${name} deleted`);
      qc.invalidateQueries({ queryKey: ["master_items"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete entry");
    }
  }

  return (
    <section className="panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{group.title}</h2>
        <span className="num text-xs text-muted-foreground">{list.length} entries</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{group.hint}</p>

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={group.placeholder}
          />
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Group (optional)</Label>
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="DevOps"
          />
        </div>
        <div className="flex items-end">
          <Button size="sm" onClick={add} disabled={busy}>
            Add
          </Button>
        </div>
      </div>

      <div className="mt-4 flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
        {list.map((i) => (
          <Badge key={i.id} variant="secondary" className="gap-1">
            {i.name}
            <button
              type="button"
              onClick={() => remove(i.id, i.name)}
              aria-label={`Delete ${i.name}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {list.length === 0 && <p className="text-xs text-muted-foreground">Nothing here yet.</p>}
      </div>
    </section>
  );
}
