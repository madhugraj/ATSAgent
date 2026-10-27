/**
 * The legal documents an organisation accepts to use ATSIQ, and their current
 * versions. Client-safe: the registration wizard, the re-accept step, the
 * public pages and the server all read this one registry, so the version a
 * person saw is the version the server records.
 *
 * Changing a document's wording means bumping its `version` (the date the new
 * text takes effect, YYYY-MM-DD). Every organisation owner is then asked to
 * accept the new version on their next sign-in, and a new `org_agreements`
 * row is written; earlier rows stay as the history.
 */
import type { LegalSection } from "@/components/LegalPage";
import { DPA_SECTIONS } from "./dpa";
import { PRIVACY_SECTIONS } from "./privacy";
import { TERMS_SECTIONS } from "./terms";

export const AGREEMENT_KINDS = ["terms", "privacy", "dpa"] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

export type AgreementDoc = {
  kind: AgreementKind;
  title: string;
  shortTitle: string;
  path: "/terms" | "/privacy" | "/dpa";
  version: string;
  /** Still awaiting legal review — shown as a banner on the page. */
  draft: boolean;
  intro: string;
  sections: LegalSection[];
};

export const AGREEMENTS: Record<AgreementKind, AgreementDoc> = {
  terms: {
    kind: "terms",
    title: "Terms of Service",
    shortTitle: "Terms",
    path: "/terms",
    version: "2026-10-27",
    draft: true,
    intro:
      "The terms on which an organisation and its users use ATSIQ, the talent-acquisition platform by Yavar AI.",
    sections: TERMS_SECTIONS,
  },
  privacy: {
    kind: "privacy",
    title: "Privacy Policy",
    shortTitle: "Privacy Policy",
    path: "/privacy",
    version: "2026-10-27",
    draft: false,
    intro:
      "How ATSIQ, the talent-acquisition platform by Yavar AI, handles organisation, recruiter and candidate data.",
    sections: PRIVACY_SECTIONS,
  },
  dpa: {
    kind: "dpa",
    title: "Data Processing Agreement",
    shortTitle: "DPA",
    path: "/dpa",
    version: "2026-10-27",
    draft: true,
    intro:
      "How Yavar AI processes personal data on behalf of an organisation using ATSIQ, as its processor (India's Digital Personal Data Protection Act 2023 'data processor'; GDPR Article 28 'processor').",
    sections: DPA_SECTIONS,
  },
};

/** Current version of every document, as the wizard sends it back. */
export function currentAgreementVersions(): Record<AgreementKind, string> {
  return {
    terms: AGREEMENTS.terms.version,
    privacy: AGREEMENTS.privacy.version,
    dpa: AGREEMENTS.dpa.version,
  };
}

/** Documents whose current version is not among the accepted (kind, version) pairs. */
export function outstandingAgreements(
  accepted: { kind: string; version: string }[],
  current: Record<AgreementKind, string> = currentAgreementVersions(),
): AgreementKind[] {
  return AGREEMENT_KINDS.filter(
    (kind) => !accepted.some((a) => a.kind === kind && a.version === current[kind]),
  );
}

/** "2026-10-27" → "27 October 2026" (UTC, so it reads the same everywhere). */
export function formatVersionDate(version: string): string {
  const d = new Date(`${version}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return version;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
