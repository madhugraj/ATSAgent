import { BrandLogo } from "@/components/Brand";
import { AGREEMENTS, type AgreementKind, formatVersionDate } from "@/lib/legal/agreements";

export type LegalSection = { title: string; body: string[] };

/** Shared reading layout for the policy pages. */
export function LegalPage({
  title,
  intro,
  sections,
  effective = "3 September 2026",
  version,
  draft = false,
}: {
  title: string;
  intro: string;
  sections: LegalSection[];
  effective?: string;
  /** Version an organisation accepts (src/lib/legal/agreements.ts). */
  version?: string;
  /** Not yet through legal review. */
  draft?: boolean;
}) {
  return (
    <article className="mx-auto max-w-3xl">
      <BrandLogo className="h-6" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{intro}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Effective {effective}
        {version ? <span className="num"> · Version {version}</span> : null}
      </p>
      {draft ? (
        <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          Draft for legal review. This document describes how ATSIQ works today; points marked "For
          legal review" are still to be settled.
        </p>
      ) : null}

      <div className="mt-8 space-y-7">
        {sections.map((s) => (
          <section key={s.title}>
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">
              {s.title}
            </h2>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground">
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

/** One of the versioned documents an organisation accepts, rendered from the registry. */
export function AgreementPage({ kind }: { kind: AgreementKind }) {
  const doc = AGREEMENTS[kind];
  return (
    <LegalPage
      title={doc.title}
      intro={doc.intro}
      sections={doc.sections}
      effective={formatVersionDate(doc.version)}
      version={doc.version}
      draft={doc.draft}
    />
  );
}
