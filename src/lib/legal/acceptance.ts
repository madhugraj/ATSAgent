import { z } from "zod";

import { currentAgreementVersions } from "./agreements";

/**
 * What a signatory sends when accepting the organisation's agreements — at
 * registration (createOrganization) and on the re-accept step
 * (acceptOrgAgreements). The versions are the ones the person was shown; the
 * server refuses them unless they are still the current ones.
 */
export const AgreementAcceptanceInput = z.object({
  accepted: z.literal(true, {
    errorMap: () => ({
      message:
        "Accept the Terms of Service, Privacy Policy and Data Processing Agreement to continue.",
    }),
  }),
  versions: z.object({
    terms: z.string().trim().min(1).max(32),
    privacy: z.string().trim().min(1).max(32),
    dpa: z.string().trim().min(1).max(32),
  }),
  signatoryName: z.string().trim().min(2, "Enter the signatory's full name").max(120),
  signatoryTitle: z.string().trim().min(2, "Enter the signatory's job title").max(120),
});

export type AgreementAcceptance = z.infer<typeof AgreementAcceptanceInput>;

/** The acceptance form as the person fills it in. */
export type AgreementDraft = { accepted: boolean; signatoryName: string; signatoryTitle: string };

export const EMPTY_AGREEMENT: AgreementDraft = {
  accepted: false,
  signatoryName: "",
  signatoryTitle: "",
};

/** What is still missing before the agreement can be sent. */
export function agreementMissing(d: AgreementDraft): string[] {
  return [
    d.signatoryName.trim().length < 2 && "Signatory name",
    d.signatoryTitle.trim().length < 2 && "Signatory title",
    !d.accepted && "Agreement acceptance",
  ].filter(Boolean) as string[];
}

/** The server payload: the versions this person was shown, plus who signed. */
export function agreementPayload(d: AgreementDraft): AgreementAcceptance {
  return {
    accepted: true,
    versions: currentAgreementVersions(),
    signatoryName: d.signatoryName.trim(),
    signatoryTitle: d.signatoryTitle.trim(),
  };
}
