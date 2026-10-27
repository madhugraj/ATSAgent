import type { LegalSection } from "@/components/LegalPage";

/**
 * Terms of Service — DRAFT for legal review. Every statement here describes
 * what the platform actually does today; commercial terms (fees, liability,
 * governing law) are deliberately left as review notes rather than invented.
 * Changing the text means bumping its version in ./agreements.
 */
export const TERMS_SECTIONS: LegalSection[] = [
  {
    title: "Who these terms are between",
    body: [
      "These terms are between Yavar AI (Yavar Techworks), which operates ATSIQ, and the organisation that registers a workspace on it. The person who registers confirms they are authorised to accept these terms, the Privacy Policy and the Data Processing Agreement on the organisation's behalf; their name, title, work email and the time of acceptance are recorded.",
    ],
  },
  {
    title: "Your workspace",
    body: [
      "One company email domain has one ATSIQ organisation. Registration needs a confirmed work email address; personal and disposable mail domains are refused.",
      "A new organisation stays locked until a Yavar AI platform administrator approves it. After approval, the owner and CHRO admins can invite colleagues on the organisation's own email domain and assign their roles.",
      "Your organisation is responsible for who it invites, the roles it grants, and for keeping its users' credentials private. Removing or pausing a user is done from Users, roles & access control.",
    ],
  },
  {
    title: "Your responsibilities for candidate data",
    body: [
      "Your organisation decides which candidates' data is brought into ATSIQ and why, and is responsible for having a lawful basis for it and for giving candidates the notices the law requires (for example under India's Digital Personal Data Protection Act 2023 or the GDPR where it applies).",
      "Where a job portal's terms limit a CV to the role it was submitted for, ATSIQ marks it as limited to that role and keeps it out of other roles, searches and shared pools; you remain responsible for following the portal's terms.",
      "Candidates ask your organisation to see, correct or delete their data; your users can correct, merge or permanently erase a candidate record in the product.",
    ],
  },
  {
    title: "AI features",
    body: [
      "Matching, scoring, verification, drafting, the copilot and the hiring agents use large-language-model providers through your organisation's own provider key, configured by your administrator. Your organisation's agreement with that provider, and its usage charges, apply to that processing.",
      "AI output is decision support. Agents can propose and request, but approving, releasing, rejecting and hiring are always decided by a person in your organisation, and scores can be overridden with a recorded reason.",
      "Prompts and outputs are kept for improving the service only if your organisation's owner turns that on (it is off by default) and can be deleted on the owner's request.",
    ],
  },
  {
    title: "Acceptable use",
    body: [
      "Do not attempt to access another organisation's data, probe or bypass the platform's security controls, overload the service, or use ATSIQ to process data you have no right to process.",
      "Do not use ATSIQ to send unsolicited bulk messages to candidates or to circumvent the terms of job portals and other services you connect.",
    ],
  },
  {
    title: "Suspension, archiving and deletion",
    body: [
      "A platform administrator can archive an organisation, which locks its users out and keeps every record so access can be restored, and can permanently delete an organisation, which removes its records, its stored files and the accounts that belong only to it.",
    ],
  },
  {
    title: "Changes to these terms",
    body: [
      "Each version of these terms carries the date it takes effect. When they change, your organisation's owner is asked to review and accept the new version the next time they sign in, and other users wait until the owner has done so.",
    ],
  },
  {
    title: "Commercial terms",
    body: [
      "[For legal review: fees and payment, service levels, warranties, limitation of liability, indemnities, term and termination, governing law and jurisdiction are to be agreed and added here before this draft is finalised.]",
    ],
  },
];
