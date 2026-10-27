import type { LegalSection } from "@/components/LegalPage";

/**
 * Data Processing Agreement — DRAFT for legal review. It records only what
 * the platform does today (see SECURITY.md, src/server/erase.server.ts and the
 * retention jobs); open points are marked "[For legal review: …]" instead of
 * being promised. AI vendors are described by category, never by name.
 * Changing the text means bumping its version in ./agreements.
 */
export const DPA_SECTIONS: LegalSection[] = [
  {
    title: "Parties and roles",
    body: [
      "This agreement is between the organisation that registers on ATSIQ (the controller, or data fiduciary under India's Digital Personal Data Protection Act 2023) and Yavar AI (Yavar Techworks), which operates ATSIQ and processes personal data on the organisation's behalf (the processor, or data processor). It forms part of the Terms of Service.",
    ],
  },
  {
    title: "What is processed",
    body: [
      "Data subjects: candidates and applicants, the organisation's users (recruiters, hiring managers, interviewers, approvers), and referees or contacts that appear in candidate documents.",
      "Personal data: names, contact details, location, CVs, education and employment history, skills, compensation expectations and offers, notice periods, interview schedules, scorecards, assessment answers, verification results, public professional profiles a candidate shares, pre-onboarding documents the organisation requests, consent flags, and the audit trail of actions taken on them.",
      "Purpose: running the organisation's recruitment — requisitions, sourcing, matching and scoring, screening, interviews, offers, onboarding and reporting — and keeping the service secure.",
    ],
  },
  {
    title: "Processing only on your instructions",
    body: [
      "Yavar AI processes the organisation's personal data only to provide ATSIQ as the organisation configures and uses it. Using a feature, connecting an integration, or setting an agent's autonomy is an instruction to process data for that feature.",
      "Yavar AI does not sell the data, use it for advertising, or use it to train or improve models unless the organisation's owner has turned training-data capture on; that setting is off by default and every change to it is audited.",
    ],
  },
  {
    title: "Confidentiality and access",
    body: [
      "Each organisation's data is visible only to its own users, limited by their roles; every server request is checked against the caller's organisation. Yavar AI personnel access an organisation's data only when needed to operate or support the platform, and platform-administrator actions are recorded in the audit log.",
    ],
  },
  {
    title: "Security measures",
    body: [
      "Sign-in uses first-party accounts with scrypt-hashed passwords and secure, HttpOnly session cookies with a bounded lifetime. Credentials stored for integrations and AI providers are encrypted at rest (AES-256-GCM) and never returned to the browser.",
      "CVs, recordings and documents are kept in private object storage and served only through authorised application paths. Public endpoints and server calls are rate-limited, server-side fetches of user-supplied links are restricted to public addresses, and privileged actions — role changes, credential changes, tenant administration — are written to an audit log.",
      "Untrusted text from CVs, job descriptions, profiles and mail is isolated before it reaches an AI model, and model output is validated before it is used.",
    ],
  },
  {
    title: "Sub-processors",
    body: [
      "Yavar AI uses these categories of service providers to run ATSIQ: cloud hosting, database and file storage; transactional email delivery.",
      "AI processing runs on the large-language-model provider the organisation selects with its own API key, under the organisation's own agreement with that provider. Meeting, calendar, job-board and HR-system providers process data only when the organisation connects them.",
      "[For legal review: the named list of Yavar AI's sub-processors, where they process data, and how the organisation is told of and may object to a new sub-processor.]",
    ],
  },
  {
    title: "Helping with data-subject requests",
    body: [
      "The organisation can answer most requests itself in the product: correct a record, merge duplicates, or permanently erase a candidate, which removes their applications, scores, interviews, evaluations, offers, assessments, verifications, profiles and stored CV files. Yavar AI routes any request it receives to the relevant organisation and assists as processor.",
    ],
  },
  {
    title: "Retention and deletion",
    body: [
      "Records are kept while the organisation's workspace is active. CVs that a job portal's terms limit to one role are, with the organisation's HR head's approval, erased 30 days after their roles are over. Deleted hiring-desk chats can be restored for 30 days and are then purged. Training-data records follow the retention period the owner sets.",
      "An archived organisation's data is kept in a restorable state. When a platform administrator permanently deletes an organisation, its records, stored files and the accounts that belong only to it are removed.",
      "[For legal review: export or return of data at the end of the service, and deletion of backups.]",
    ],
  },
  {
    title: "Personal-data breaches",
    body: [
      "If Yavar AI becomes aware of a breach affecting the organisation's personal data it will notify the organisation without undue delay and share what it knows to help the organisation meet its own obligations to regulators and data subjects.",
      "[For legal review: notification timeframe and contact channel.]",
    ],
  },
  {
    title: "Transfers, audits and changes",
    body: [
      "[For legal review: the hosting region and any cross-border transfer mechanism; how the organisation may verify compliance (information requests, audits).]",
      "Each version of this agreement carries the date it takes effect. When it changes, the organisation's owner is asked to review and accept the new version on their next sign-in, and the acceptance is recorded.",
    ],
  },
];
