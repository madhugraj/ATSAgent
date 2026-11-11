import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, List, Search } from "lucide-react";

import { MANUAL_SECTIONS, type ManualSection } from "@/lib/user-manual";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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

/** "19. Agent oversight…" → 19; unnumbered sections are front matter. */
function chapterNo(title: string): number | null {
  const m = /^(\d+)\.\s/.exec(title);
  return m ? Number(m[1]) : null;
}

function chapterEyebrow(s: ManualSection): string {
  const n = chapterNo(s.title);
  return n === null ? "Front matter" : `Chapter ${n}`;
}

function escapeRegExp(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap each match of the search needle in a highlight mark. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, "ig"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={i} className="rounded-sm bg-accent/35 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Help() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const needle = q.trim().toLowerCase();
  const searching = needle.length > 0;

  const matches = useMemo(() => {
    if (!searching) return [];
    return MANUAL_SECTIONS.map((s) => ({
      section: s,
      steps: s.steps.filter((t) => t.toLowerCase().includes(needle)),
      inSummary: s.summary.toLowerCase().includes(needle),
    })).filter((m) => m.inSummary || m.steps.length > 0);
  }, [needle, searching]);

  const openSection = open === null ? null : MANUAL_SECTIONS[open];

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.key === "ArrowLeft") setOpen((o) => (o === null ? o : Math.max(0, o - 1)));
      if (e.key === "ArrowRight")
        setOpen((o) =>
          o === null ? o : Math.min(MANUAL_SECTIONS.length - 1, o + 1),
        );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [open, searching]);

  const searchBox = (
    <div className="relative max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search the manual"
        className="pl-8"
      />
    </div>
  );

  // A chapter is open — render it as one book page.
  if (openSection && !searching) {
    const prev = open !== null && open > 0 ? MANUAL_SECTIONS[open - 1] : null;
    const next =
      open !== null && open < MANUAL_SECTIONS.length - 1
        ? MANUAL_SECTIONS[open + 1]
        : null;
    return (
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
            <List className="size-4" />
            Contents
          </Button>
          <p className="text-xs text-muted-foreground">
            Use ← and → to turn the pages
          </p>
        </div>

        <article
          id={openSection.id}
          className="panel space-y-6 rounded-none border-y px-6 py-10 shadow-sm sm:px-14 sm:py-14"
        >
          <header className="space-y-3 border-b pb-6 text-center">
            <p className="font-book text-xs tracking-[0.25em] text-muted-foreground uppercase">
              {chapterEyebrow(openSection)}
            </p>
            <h1 className="font-book text-3xl leading-tight font-medium text-balance sm:text-4xl">
              {openSection.title}
            </h1>
            <p className="font-book mx-auto max-w-xl text-base leading-relaxed italic text-muted-foreground">
              {openSection.summary}
            </p>
          </header>

          <ol className="space-y-5">
            {openSection.steps.map((t, i) => (
              <li key={i} className="grid grid-cols-[2rem_1fr] gap-x-3 sm:grid-cols-[2.5rem_1fr]">
                <span className="font-book pt-px text-right text-sm text-primary/70 tabular-nums">
                  {i + 1}.
                </span>
                <p className="font-book text-[0.98rem] leading-relaxed text-foreground/90">
                  <Highlight text={t} needle={q.trim()} />
                </p>
              </li>
            ))}
          </ol>

          <footer className="border-t pt-4 text-center">
            <p className="font-book text-xs tracking-widest text-muted-foreground uppercase">
              ATSIQ user manual · page {open! + 1} of {MANUAL_SECTIONS.length}
            </p>
          </footer>
        </article>

        <nav className="mt-5 flex items-stretch justify-between gap-3">
          {prev ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(open! - 1)}
              className="max-w-[45%] items-center justify-start"
            >
              <ArrowLeft className="size-4 shrink-0" />
              <span className="truncate">{prev.title}</span>
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(open! + 1)}
              className="ml-auto max-w-[45%] items-center justify-end"
            >
              <span className="truncate">{next.title}</span>
              <ArrowRight className="size-4 shrink-0" />
            </Button>
          ) : (
            <span />
          )}
        </nav>
      </div>
    );
  }

  // Searching — matching chapters with the steps that match, excerpts first.
  if (searching) {
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {searchBox}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {matches.length} matching {matches.length === 1 ? "chapter" : "chapters"}
          </p>
        </div>

        <div className="mx-auto max-w-3xl space-y-6">
          {matches.map(({ section, steps, inSummary }) => {
            const idx = MANUAL_SECTIONS.indexOf(section);
            return (
              <section key={section.id} className="space-y-3">
                <button
                  onClick={() => setOpen(idx)}
                  className="group block w-full text-left"
                >
                  <p className="font-book text-xs tracking-[0.25em] text-muted-foreground uppercase">
                    {chapterEyebrow(section)}
                  </p>
                  <h2 className="font-book text-xl font-medium group-hover:text-primary group-hover:underline">
                    {section.title}
                  </h2>
                  {inSummary && (
                    <p className="font-book text-sm italic text-muted-foreground">
                      <Highlight text={section.summary} needle={q.trim()} />
                    </p>
                  )}
                </button>
                <ul className="space-y-2">
                  {steps.map((t, i) => {
                    const at = t.toLowerCase().indexOf(needle);
                    const start = Math.max(0, at - 80);
                    const excerpt =
                      (start > 0 ? "… " : "") +
                      t.slice(start, at + needle.length + 120) +
                      (at + needle.length + 120 < t.length ? " …" : "");
                    return (
                      <li key={i}>
                        <button
                          onClick={() => setOpen(idx)}
                          className="font-book block w-full text-left text-sm leading-relaxed text-foreground/85 hover:text-primary"
                        >
                          <Highlight text={excerpt} needle={q.trim()} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {matches.length === 0 && (
            <p className="font-book text-base italic text-muted-foreground">
              Nothing in the manual matches “{q.trim()}”.
            </p>
          )}
        </div>
      </>
    );
  }

  // The book: cover, then table of contents.
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-10 flex justify-end">{searchBox}</div>

      {/* Cover */}
      <div className="panel flex min-h-72 flex-col items-center justify-center gap-4 rounded-none border-y px-8 py-16 text-center shadow-sm">
        <p className="font-book text-xs tracking-[0.3em] text-muted-foreground uppercase">
          Help
        </p>
        <h1 className="font-display text-4xl font-semibold text-balance sm:text-5xl">
          User manual
        </h1>
        <div className="flex w-40 items-center gap-2" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          <BookOpen className="size-4 text-primary" />
          <span className="h-px flex-1 bg-border" />
        </div>
        <p className="font-book max-w-xl text-base leading-relaxed text-muted-foreground italic">
          How to configure and run the platform, from organisation registration
          to hires. The HR copilot answers from this same manual.
        </p>
        <p className="font-book text-xs tracking-widest text-muted-foreground uppercase">
          {MANUAL_SECTIONS.length} chapters
        </p>
      </div>

      {/* Table of contents */}
      <nav className="mt-12" aria-label="Table of contents">
        <h2 className="font-book mb-6 text-center text-xs tracking-[0.3em] text-muted-foreground uppercase">
          Contents
        </h2>
        <ol className="space-y-1">
          {MANUAL_SECTIONS.map((s, i) => (
            <li key={s.id}>
              <button
                onClick={() => setOpen(i)}
                className="group flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/40"
              >
                <span className="font-book text-sm tabular-nums text-muted-foreground">
                  {chapterNo(s.title) ?? "·"}
                </span>
                <span className="font-book text-[0.98rem] font-medium group-hover:text-primary">
                  {s.title}
                </span>
                <span
                  aria-hidden="true"
                  className="mx-1 min-w-6 flex-1 border-b border-dotted border-border"
                />
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
