import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";

import { MANUAL_SECTIONS } from "@/lib/user-manual";
import { PageHeader } from "@/components/ats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/help")({
  head: () => ({
    meta: [
      { title: "User manual — set up and run ATSIQ hiring" },
      {
        name: "description",
        content:
          "Step-by-step ATSIQ manual for setup, sourcing, JD-CV matching, screening, recruiter collaboration, interviews, offers and leadership governance.",
      },
      { property: "og:title", content: "ATSIQ user manual" },
      {
        property: "og:description",
        content:
          "Everything an organisation needs to configure and operate ATSIQ, from hiring demand through joining and governance.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Help,
});

function Help() {
  const [q, setQ] = useState("");

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return MANUAL_SECTIONS;
    return MANUAL_SECTIONS.filter((s) =>
      [s.title, s.summary, ...s.steps].some((t) => t.toLowerCase().includes(needle)),
    );
  }, [q]);

  return (
    <>
      <PageHeader
        eyebrow="Help"
        title="User manual"
        description="How to configure and run the platform, from organisation registration to hires. The HR copilot answers from this same manual."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void import("@/lib/manual-export").then((m) => m.downloadManualPdf())}
            >
              <Download className="size-4" /> Download PDF
            </Button>
            <Button variant="outline" asChild>
              <a href="/ATSIQ_Product_Handbook.docx" download>
                <Download className="size-4" /> Product handbook
              </a>
            </Button>
          </>
        }
      />

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the manual"
          className="pl-8"
        />
      </div>

      <nav className="panel flex flex-wrap gap-x-4 gap-y-1 p-3 text-xs text-muted-foreground">
        {MANUAL_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="hover:text-foreground">
            {s.title}
          </a>
        ))}
      </nav>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {q.trim() ? `${sections.length} matching sections` : `${MANUAL_SECTIONS.length} sections`}
      </p>

      <div className="grid items-start gap-3 xl:grid-cols-2">
        {sections.map((s) => (
          <section key={s.id} id={s.id} className="panel scroll-mt-20 space-y-2 p-5">
            <h2 className="text-sm font-semibold">{s.title}</h2>
            <p className="text-sm text-muted-foreground">{s.summary}</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              {s.steps.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
          </section>
        ))}
        {sections.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing in the manual matches “{q}”.</p>
        )}
      </div>
    </>
  );
}
